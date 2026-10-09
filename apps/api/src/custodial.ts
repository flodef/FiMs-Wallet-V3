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
import { createBackendSigner } from './signer.js'
import { yieldInstructions } from './yield-placement.js'

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
    custodialSignerPromise = createBackendSigner('CUSTODIAL', custodialSecretKey)
  }
  return custodialSignerPromise
}

export async function custodialAddress(): Promise<Address> {
  return (await custodialSigner()).address
}

const rpcUrl = () => process.env['SOLANA_RPC_URL'] ?? 'https://api.mainnet-beta.solana.com'

const TOKEN_PROGRAM_ADDRESS = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' as Address
const SYSTEM_PROGRAM_ADDRESS = '11111111111111111111111111111111' as Address

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

// ---------------------------------------------------------------------------
// Custody simulation guard.
//
// The custodial key signs composed transactions that include instructions
// fetched over HTTP from yield providers. The structural allowlist in
// yield-placement.ts narrows what providers may ask for, but the definitive
// check is outcome-based: before sending, the transaction is simulated and
// every custody-owned token account is compared pre/post. A debit that was
// not explicitly declared by the caller fails closed — a provider cannot
// drain the float, the yield positions, or move lamports beyond fee+rent.
// ---------------------------------------------------------------------------
export interface CustodyGuard {
  // Custody token account → max base units the transaction may debit. Any
  // other custody token account must be untouched or credited only.
  maxDebits?: ReadonlyMap<Address, bigint>
  // Max lamports the custody wallet may lose — fees + member ATA rent.
  maxLamports?: bigint
}

const DEFAULT_MAX_LAMPORTS = 10_000_000n // 0.01 SOL

// SPL Token / Token-2022 base account: mint(32) + owner(32) + amount u64 LE.
function tokenAccountAmount(data: string | undefined): bigint {
  if (!data) return 0n
  const bytes = Uint8Array.from(atob(data), (char) => char.charCodeAt(0))
  if (bytes.length < 72) return 0n
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getBigUint64(64, true)
}

function accountDataBase64(data: unknown): string | undefined {
  if (typeof data === 'string') return data
  if (Array.isArray(data) && typeof data[0] === 'string') return data[0]
  return undefined
}

async function assertCustodySimulation(wire: string, custody: Address, guard: CustodyGuard): Promise<void> {
  const rpc = createSolanaRpc(rpcUrl())
  // Enumerate every custody token account — the set the guard must protect.
  const pre = new Map<Address, bigint>()
  const watched: Address[] = []
  for (const programId of [TOKEN_PROGRAM_ADDRESS, TOKEN_2022_PROGRAM_ADDRESS]) {
    const { value } = await rpcCall(() =>
      rpc.getTokenAccountsByOwner(custody, { programId }, { encoding: 'base64' }).send(),
    )
    for (const { pubkey, account } of value) {
      pre.set(pubkey, tokenAccountAmount(accountDataBase64(account.data)))
      watched.push(pubkey)
    }
  }
  const { value: preLamports } = await rpcCall(() => rpc.getBalance(custody).send())
  const response = await rpcCall(() =>
    rpc
      .simulateTransaction(wire as never, {
        accounts: { addresses: [custody, ...watched], encoding: 'base64' },
        commitment: 'confirmed',
        encoding: 'base64',
        replaceRecentBlockhash: true,
        sigVerify: false,
      })
      .send(),
  )
  const value = response.value as {
    accounts?: ({ data?: unknown; lamports?: bigint | number | string; owner?: string } | null)[] | null
    err: unknown
  }
  if (value.err) throw new Error(`custody simulation failed: ${JSON.stringify(value.err)}`)
  const accounts = value.accounts ?? []
  const walletAccount = accounts[0]
  if (!walletAccount || `${walletAccount.owner}` !== SYSTEM_PROGRAM_ADDRESS) {
    throw new Error('custody simulation changed the wallet owner')
  }
  const postLamports = BigInt(walletAccount.lamports ?? preLamports)
  const lamportDebit = preLamports - postLamports
  const maxLamports = guard.maxLamports ?? DEFAULT_MAX_LAMPORTS
  if (lamportDebit > maxLamports) {
    throw new Error(`custody simulation spends ${lamportDebit} lamports (max ${maxLamports})`)
  }
  for (let i = 0; i < watched.length; i++) {
    const account = accounts[i + 1]
    if (!account) continue // absent from simulation → unchanged
    const debit = (pre.get(watched[i] as Address) ?? 0n) - tokenAccountAmount(accountDataBase64(account.data))
    if (debit <= 0n) continue
    const allowed = guard.maxDebits?.get(watched[i] as Address) ?? 0n
    if (debit > allowed) {
      throw new Error(`custody simulation debits ${debit} from ${watched[i]} (allowed ${allowed})`)
    }
  }
}

// Send + confirm a transaction signed by the custodial keypair. Confirmation
// is polled over HTTP (no websocket in the worker); ~30 s worst case. The
// custody guard simulates the signed transaction first and aborts on any
// undeclared debit of a custody account.
async function sendCustodialTransaction(instructions: Instruction[], guard: CustodyGuard = {}): Promise<Signature> {
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
  await assertCustodySimulation(wire, signer.address, guard)
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

// Mint `productUnits` of the product token to `owner` — creates their ATA
// first when needed. When a yield venue is configured, `backingUnits` are
// deposited into it in the same transaction (atomic placement + mint).
export async function custodialMint(
  product: FimsWrappedProduct,
  owner: Address,
  productUnits: bigint,
  backingUnits: bigint,
): Promise<Signature> {
  const config = wrappedProductConfig(product)
  if (!config) throw new Error(`${product} mint is not configured`)
  const signer = await custodialSigner()
  const destinationAta = await ata(config.mint, owner)
  const depositIxs = await yieldInstructions(product, 'deposit', config, signer.address, backingUnits)
  const debits = new Map<Address, bigint>()
  if (depositIxs.length > 0) {
    const backingProgram = await mintProgram(config.backingMint)
    debits.set(await ata(config.backingMint, signer.address, backingProgram), backingUnits)
  }
  const signature = await sendCustodialTransaction(
    [
      getCreateAssociatedTokenIdempotentInstruction({
        ata: destinationAta,
        mint: config.mint,
        owner,
        payer: signer,
        tokenProgram: TOKEN_2022_PROGRAM_ADDRESS,
      }),
      ...depositIxs,
      getMintToInstruction(
        { amount: productUnits, mint: config.mint, mintAuthority: signer, token: destinationAta },
        { programAddress: TOKEN_2022_PROGRAM_ADDRESS },
      ),
    ],
    { maxDebits: debits },
  )
  // Best-effort float sweep right after minting — the backing just landed, so
  // move the excess to the multisig vault now rather than waiting for the
  // keeper. A failure must not fail the mint: the backing is already safe in
  // custody and the next keeper pass sweeps it.
  try {
    await custodialSweep(product)
  } catch {
    // logged nowhere on purpose: sweep failures surface in backing-status.
  }
  return signature
}

// ---------------------------------------------------------------------------
// Backing vault (Squads multisig) + float.
//
// The hot custodial key is the mint authority AND the wallet holding all the
// EURC/USDG backing: a leaked key could drain everything. The mitigation is
// structural, on-chain: the wallet only keeps a capped float — enough to
// honor redeems instantly — and a keeper sweeps every excess unit to a
// Squads vault whose signers are humans (2-of-3). The hot key can send TO
// the vault but never FROM it, so a leak only ever exposes the float.
//
// Ops: create the multisig once (wallet UI or Squads app), then set
// FIMS_BACKING_VAULT to its vault PDA. Unset = vault feature off.
// ---------------------------------------------------------------------------

export function backingVault(): Address | null {
  const raw = process.env['FIMS_BACKING_VAULT']
  return raw ? address(raw) : null
}

// Float target per product, in the backing token's base units (6 decimals).
// FIMS_EURO_FLOAT / FIMS_USD_FLOAT override the 200-unit default.
const FLOAT_ENV: Record<FimsWrappedProduct, string> = {
  'fims-eur': 'FIMS_EURO_FLOAT',
  'fims-usd': 'FIMS_USD_FLOAT',
}
const FLOAT_DEFAULT_UNITS = 200n

export function floatTarget(product: FimsWrappedProduct): bigint {
  const config = wrappedProductConfig(product)
  const raw = process.env[FLOAT_ENV[product]]
  const units = raw !== undefined ? BigInt(raw) : FLOAT_DEFAULT_UNITS
  return units * (config?.units ?? 1_000_000n)
}

// Pure sweep decision: above the float target, move the excess; at or below,
// nothing to do. Exported for tests.
export function sweepAmount(balance: bigint, target: bigint): bigint {
  return balance > target ? balance - target : 0n
}

async function tokenBalance(tokenAccount: Address): Promise<bigint> {
  const rpc = createSolanaRpc(rpcUrl())
  const { value } = await rpcCall(() => rpc.getTokenAccountBalance(tokenAccount).send())
  return BigInt(value.amount)
}

// Transfer the excess above floatTarget to the vault's ATA. Called after
// every mint (best-effort) and by the keeper cron — both paths idempotent.
export async function custodialSweep(product: FimsWrappedProduct): Promise<{
  product: FimsWrappedProduct
  swept: bigint
  signature: Signature | null
}> {
  const config = wrappedProductConfig(product)
  const vault = backingVault()
  if (!config || !vault) return { product, signature: null, swept: 0n }
  const signer = await custodialSigner()
  const backingProgram = await mintProgram(config.backingMint)
  const custodyAta = await ata(config.backingMint, signer.address, backingProgram)
  const amount = sweepAmount(await tokenBalance(custodyAta), floatTarget(product))
  if (amount === 0n) return { product, signature: null, swept: 0n }
  const vaultAta = await ata(config.backingMint, vault, backingProgram)
  const signature = await sendCustodialTransaction(
    [
      getCreateAssociatedTokenIdempotentInstruction({
        ata: vaultAta,
        mint: config.backingMint,
        owner: vault,
        payer: signer,
        tokenProgram: backingProgram,
      }),
      getTransferCheckedInstruction(
        {
          amount,
          authority: signer,
          decimals: 6,
          destination: vaultAta,
          mint: config.backingMint,
          source: custodyAta,
        },
        { programAddress: backingProgram },
      ),
    ],
    { maxDebits: new Map([[custodyAta, amount]]) },
  )
  return { product, signature, swept: amount }
}

export interface BackingStatusRow {
  // All amounts in the backing token's base units.
  backingTotal: string
  float: string
  floatTarget: string
  healthy: boolean
  product: FimsWrappedProduct
  supply: string
  vault: string
}

// For the monitor cron: the backing must cover the whole wrapped supply at
// the current operator price — redeem all supply = supply * price backing
// units. Anything less means unbacked product in circulation (leaked mint
// authority or a bug). `prices` maps product symbol (EURF/USDF) → the same
// index `wrappedTransfer` uses in the tokens table.
export async function custodialBackingStatus(prices: Readonly<Record<string, number>>): Promise<BackingStatusRow[]> {
  const rpc = createSolanaRpc(rpcUrl())
  const signer = await custodialSigner()
  const vault = backingVault()
  const rows: BackingStatusRow[] = []
  for (const product of Object.keys(PRODUCTS) as FimsWrappedProduct[]) {
    const config = wrappedProductConfig(product)
    if (!config) continue
    const backingProgram = await mintProgram(config.backingMint)
    const custodyAta = await ata(config.backingMint, signer.address, backingProgram)
    const vaultAta = vault ? await ata(config.backingMint, vault, backingProgram) : null
    const { value: supply } = await rpcCall(() => rpc.getTokenSupply(config.mint).send())
    const float = await tokenBalance(custodyAta)
    const vaultBalance = vaultAta ? await tokenBalance(vaultAta).catch(() => 0n) : 0n
    const backingTotal = float + vaultBalance
    const supplyUnits = BigInt(supply.amount)
    const price = prices[config.symbol] ?? 0
    const required = price > 0 ? BigInt(Math.ceil(Number(supplyUnits) * price)) : 0n
    rows.push({
      backingTotal: backingTotal.toString(),
      float: float.toString(),
      floatTarget: floatTarget(product).toString(),
      healthy: backingTotal >= required,
      product,
      supply: supplyUnits.toString(),
      vault: vaultBalance.toString(),
    })
  }
  return rows
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
  if (backingVault()) {
    const float = await tokenBalance(backingCustodyAta)
    if (backingUnits > float) {
      throw new Error(
        `redeem of ${backingUnits} exceeds the available float (${float}) — ` +
          'the FiMs team must top it up from the multisig vault',
      )
    }
  }
  const withdrawIxs = await yieldInstructions(product, 'withdraw', config, signer.address, backingUnits)
  const debits = new Map<Address, bigint>([
    [custodyAta, productUnits],
    [backingCustodyAta, backingUnits],
  ])
  return sendCustodialTransaction(
    [
      getBurnInstruction(
        { account: custodyAta, amount: productUnits, authority: signer, mint: config.mint },
        { programAddress: TOKEN_2022_PROGRAM_ADDRESS },
      ),
      ...withdrawIxs,
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
    ],
    { maxDebits: debits },
  )
}
