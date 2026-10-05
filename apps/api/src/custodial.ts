// cspell:ignore mints ABCDEFGHJKLMNPQRSTUVWXY Zabcdefghijkmnopqrstuvwxyz
// Custodial mint/burn service for the wrapped FiMs stable products.
//
// The worker holds a hot keypair (CUSTODIAL_KEYPAIR, a wrangler secret) that
// is the mint authority of two Token-2022 mints:
//   - FiMs Euro (FIMS_EURO_MINT) — backed 1:1 by EURC held in custody
//   - FiMs USD  (FIMS_USD_MINT)  — backed 1:1 by USDG held in custody
//
// Deposit: the member sends backing (EURC/USDG) to the custody wallet; once
// the transfer is verified on-chain (solana-rpc.ts), the custodial mints the
// same units of the FiMs token to the member's ATA. Redeem: the member sends
// the FiMs token back to custody; the custodial burns it and returns the
// backing. The ledger records both in the BACKING symbol so members only ever
// see EURC/USDC — the wrapped mint is an implementation detail.
//
// The custody wallet is also where the backing is placed for yield (Jupiter
// Earn jlEURC / Kamino USDG) — those placements are operator actions done
// with the same key, outside the request path.
import {
  type Address,
  address,
  appendTransactionMessageInstructions,
  createKeyPairSignerFromBytes,
  createSolanaRpc,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  type Instruction,
  pipe,
  type Signature,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  type TransactionSigner,
} from '@solana/kit'
import { findAssociatedTokenPda } from '@solana-program/token'
import {
  getBurnInstruction,
  getCreateAssociatedTokenIdempotentInstruction,
  getMintToInstruction,
  getTransferCheckedInstruction,
  TOKEN_2022_PROGRAM_ADDRESS,
} from '@solana-program/token-2022'

// Mainnet backing mints. Overridable via env so devnet can point at test
// mints created by scripts/create-fims-mints.ts.
const EURC_MINT = 'HzwqbKZw8HxMN6bF2yFZNrht3c2iXXzpKcFu7uBEDKtr'
const USDG_MINT = '2u1tszSeqZ3qBWF3uNGPFc8TzMk2tdiwknnRMWGWjGWH'

export type FimsWrappedProduct = 'fims-eur' | 'fims-usd'

export interface WrappedProductConfig {
  // Mint the member deposits / gets back on redeem.
  backingMint: Address
  // Token-2022 mint held by the custodial keypair.
  mint: Address
  // Product ticker — ledger rows and the price index use this symbol.
  symbol: string
  // All four tokens use 6 decimals.
  units: bigint
}

const PRODUCTS: Record<
  FimsWrappedProduct,
  { backingEnv: string; backingFallback: string; mintEnv: string; symbol: string }
> = {
  'fims-eur': {
    backingEnv: 'FIMS_EURO_BACKING_MINT',
    backingFallback: EURC_MINT,
    mintEnv: 'FIMS_EURO_MINT',
    symbol: 'EURF',
  },
  'fims-usd': {
    backingEnv: 'FIMS_USD_BACKING_MINT',
    backingFallback: USDG_MINT,
    mintEnv: 'FIMS_USD_MINT',
    symbol: 'USDF',
  },
}

export function wrappedProductConfig(product: FimsWrappedProduct): WrappedProductConfig | null {
  const def = PRODUCTS[product]
  const mint = process.env[def.mintEnv]
  if (!mint) return null
  return {
    backingMint: address(process.env[def.backingEnv] || def.backingFallback),
    mint: address(mint),
    symbol: def.symbol,
    units: 1_000_000n,
  }
}

// Every backing mint a deposit may carry, resolved to its product. A tx that
// credits custody with anything else is not a valid wrapped deposit.
export function productForBackingMint(mint: string): FimsWrappedProduct | null {
  for (const product of Object.keys(PRODUCTS) as FimsWrappedProduct[]) {
    const config = wrappedProductConfig(product)
    if (config && config.backingMint === mint) return product
  }
  return null
}

export function productForWrappedMint(mint: string): FimsWrappedProduct | null {
  for (const product of Object.keys(PRODUCTS) as FimsWrappedProduct[]) {
    const config = wrappedProductConfig(product)
    if (config && config.mint === mint) return product
  }
  return null
}

// Secret key as JSON byte array ("[12,34,...]") or base58 — both are the
// 64-byte ed25519 secret key output of solana-keygen.
function custodialSecretKey(): Uint8Array {
  const raw = process.env['CUSTODIAL_KEYPAIR']
  if (!raw) throw new Error('CUSTODIAL_KEYPAIR is not configured')
  const bytes = raw.trim().startsWith('[')
    ? Uint8Array.from(JSON.parse(raw) as number[])
    : Uint8Array.from(decodeBase58(raw.trim()))
  if (bytes.length !== 64) throw new Error('CUSTODIAL_KEYPAIR must be a 64-byte secret key')
  return bytes
}

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
function decodeBase58(text: string): number[] {
  const digits = [0]
  for (const char of text) {
    const value = BASE58_ALPHABET.indexOf(char)
    if (value < 0) throw new Error('CUSTODIAL_KEYPAIR: invalid base58 character')
    let carry = value
    for (let i = 0; i < digits.length; i++) {
      carry += (digits[i] ?? 0) * 58
      digits[i] = carry & 0xff
      carry >>= 8
    }
    while (carry) {
      digits.push(carry & 0xff)
      carry >>= 8
    }
  }
  for (const char of text) {
    if (char !== '1') break
    digits.push(0)
  }
  return digits.reverse()
}

// Cache the signer per process — instructions and the fee payer must share
// the same signer instance or @solana/signers dedup rejects the message.
let custodialSignerPromise: Promise<TransactionSigner> | undefined
function custodialSigner(): Promise<TransactionSigner> {
  if (!custodialSignerPromise) {
    custodialSignerPromise = createKeyPairSignerFromBytes(custodialSecretKey())
  }
  return custodialSignerPromise
}

export async function custodialAddress(): Promise<Address> {
  return (await custodialSigner()).address
}

const rpcUrl = () => process.env['SOLANA_RPC_URL'] ?? 'https://api.mainnet-beta.solana.com'

// Public RPCs rate-limit hard — retry transient 429s before giving up.
async function rpcCall<T>(fn: () => Promise<T>): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await fn()
    } catch (error) {
      if (i > 8 || !`${error}`.includes('429')) throw error
      await new Promise((resolve) => setTimeout(resolve, 1500))
    }
  }
}

// Send + confirm a transaction signed by the custodial keypair. Confirmation
// is polled over HTTP (no websocket in the worker); ~30 s worst case.
async function sendCustodialTransaction(instructions: Instruction[]): Promise<Signature> {
  const signer = await custodialSigner()
  const rpc = createSolanaRpc(rpcUrl())
  const { value: latestBlockhash } = await rpcCall(() => rpc.getLatestBlockhash().send())
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (tx) => appendTransactionMessageInstructions(instructions, tx),
    (tx) => setTransactionMessageFeePayerSigner(signer, tx),
    (tx) => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, tx),
  )
  const signed = await signTransactionMessageWithSigners(message)
  const wire = getBase64EncodedWireTransaction(signed)
  const signature = (await rpcCall(() =>
    rpc.sendTransaction(wire, { encoding: 'base64', skipPreflight: false }).send(),
  )) as Signature

  for (let attempt = 0; attempt < 40; attempt++) {
    const { value } = await rpcCall(() =>
      rpc.getSignatureStatuses([signature], { searchTransactionHistory: true }).send(),
    )
    const status = value[0]
    if (status?.err) throw new Error(`custodial transaction failed: ${JSON.stringify(status.err)}`)
    if (status && (status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized')) {
      return signature
    }
    await new Promise((resolve) => setTimeout(resolve, 750))
  }
  throw new Error('custodial transaction was not confirmed in time')
}

// Backing mints are not all on the same token program: EURC is legacy SPL,
// USDG and the FiMs mints are Token-2022. Resolve each mint's owning program
// once per process so ATAs and instructions target the right program —
// including devnet backing overrides.
const mintProgramCache = new Map<string, Address>()
async function mintProgram(mint: Address): Promise<Address> {
  const cached = mintProgramCache.get(mint)
  if (cached) return cached
  const rpc = createSolanaRpc(rpcUrl())
  const { value } = await rpcCall(() => rpc.getAccountInfo(mint, { encoding: 'base64' }).send())
  if (!value) throw new Error(`mint not found: ${mint}`)
  const program = address(value.owner)
  mintProgramCache.set(mint, program)
  return program
}

const ata = async (mint: Address, owner: Address, tokenProgram?: Address) =>
  (
    await findAssociatedTokenPda({
      mint,
      owner,
      tokenProgram: tokenProgram ?? (await mintProgram(mint)),
    })
  )[0]

// Mint `units` of the product token to `owner` — creates their ATA first when
// needed. The custodial pays rent and fees.
export async function custodialMint(product: FimsWrappedProduct, owner: Address, units: bigint): Promise<Signature> {
  const config = wrappedProductConfig(product)
  if (!config) throw new Error(`${product} mint is not configured`)
  const signer = await custodialSigner()
  const destinationAta = await ata(config.mint, owner)
  const createAtaIx = getCreateAssociatedTokenIdempotentInstruction({
    ata: destinationAta,
    mint: config.mint,
    owner,
    payer: signer,
    tokenProgram: TOKEN_2022_PROGRAM_ADDRESS,
  })
  return sendCustodialTransaction([
    createAtaIx,
    getMintToInstruction(
      { amount: units, mint: config.mint, mintAuthority: signer, token: destinationAta },
      { programAddress: TOKEN_2022_PROGRAM_ADDRESS },
    ),
  ])
}

// Burn `productUnits` of the product token held by custody and return
// `backingUnits` of backing to `owner` — creating their backing ATA when
// needed. The product/backing rate is priced off-chain (tokens table).
export async function custodialRedeem(
  product: FimsWrappedProduct,
  owner: Address,
  productUnits: bigint,
  backingUnits: bigint,
): Promise<Signature> {
  const config = wrappedProductConfig(product)
  if (!config) throw new Error(`${product} mint is not configured`)
  const signer = await custodialSigner()
  const backingProgram = await mintProgram(config.backingMint)
  const custodyAta = await ata(config.mint, signer.address, TOKEN_2022_PROGRAM_ADDRESS)
  const backingCustodyAta = await ata(config.backingMint, signer.address, backingProgram)
  const destinationAta = await ata(config.backingMint, owner, backingProgram)
  return sendCustodialTransaction([
    getBurnInstruction(
      { account: custodyAta, amount: productUnits, authority: signer, mint: config.mint },
      { programAddress: TOKEN_2022_PROGRAM_ADDRESS },
    ),
    getCreateAssociatedTokenIdempotentInstruction({
      ata: destinationAta,
      mint: config.backingMint,
      owner,
      payer: signer,
      tokenProgram: backingProgram,
    }),
    getTransferCheckedInstruction(
      {
        amount: backingUnits,
        authority: signer,
        decimals: 6,
        destination: destinationAta,
        mint: config.backingMint,
        source: backingCustodyAta,
      },
      { programAddress: backingProgram },
    ),
  ])
}
