// cspell:ignore mints ABCDEFGHJKLMNPQRSTUVWXY Zabcdefghijkmnopqrstuvwxyz
// Custodial mint/burn service for the wrapped FiMs stable products.
//
// The worker holds a hot keypair (CUSTODIAL_KEYPAIR, a wrangler secret) that
// is the mint authority of two Token-2022 mints:
//   - FiMs Euro (FIMS_EURO_MINT) — backed by EURC held in custody
//   - FiMs USD  (FIMS_USD_MINT)  — backed by USDG held in custody
//
// Deposit: the member sends backing (EURC/USDG) to the custody wallet; once
// the transfer is verified on-chain (solana-rpc.ts), the custodial mints
// FiMs-token units priced at the NAV index (`tokens` table, EURF/USDF
// symbol) net of the wrap fee to the member's ATA. Redeem: the member
// sends the FiMs token back to custody; the custodial burns it and returns
// backing priced at the same index net of the fee. The ledger records both
// legs in the product symbol (EURF/USDF) so members track the product, not
// the raw backing — the wrapped mint is an implementation detail.
//
// The custody wallet is also where the backing is placed for yield (Jupiter
// Earn jlEURC / Kamino USDG) — those placements are operator actions done
// with the same key, outside the request path.

import { getBase58Encoder } from '@solana/codecs-strings'
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
import { envBigint } from './env.js'
import { createBackendSigner } from './signer.js'
import { rpcCall, rpcUrl, tokenBalance } from './solana-util.js'
import { yieldConfigured, yieldInstructions, yieldPositionAta } from './yield-placement.js'

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
    : Uint8Array.from(getBase58Encoder().encode(raw.trim()))
  if (bytes.length !== 64) throw new Error('CUSTODIAL_KEYPAIR must be a 64-byte secret key')
  return bytes
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

const TOKEN_PROGRAM_ADDRESS = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' as Address
const SYSTEM_PROGRAM_ADDRESS = '11111111111111111111111111111111' as Address

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

// SPL token account layout (shared by Token and Token-2022 up to the
// extension area): delegate/close-authority/state sit at fixed offsets. A
// simulated instruction that changes any of them — approve, set-authority,
// freeze — is a custody take-over even when the balance does not move.
const TOKEN_DELEGATE_RANGE: [number, number] = [72, 108] // option tag + pubkey
const TOKEN_STATE_OFFSET = 108 // 1 = initialized, 2 = frozen
const TOKEN_CLOSE_AUTHORITY_RANGE: [number, number] = [129, 165]

function accountSlice(data: string | undefined, [from, to]: [number, number]): string | undefined {
  if (!data) return undefined
  const bytes = Uint8Array.from(atob(data), (char) => char.charCodeAt(0))
  if (bytes.length < to) return undefined
  return btoa(String.fromCharCode(...bytes.slice(from, to)))
}

// Exported for tests — the guard is pure over stubbed JSON-RPC responses.
export async function assertCustodySimulation(wire: string, custody: Address, guard: CustodyGuard): Promise<void> {
  const rpc = createSolanaRpc(rpcUrl())
  // Enumerate every custody token account — the set the guard must protect.
  // Pre-state keeps the FULL account data so delegate/close-authority/state
  // bytes can be diffed after simulation, not just the balance.
  const pre = new Map<Address, { amount: bigint; data: string | undefined; owner: string }>()
  const watched: Address[] = []
  for (const programId of [TOKEN_PROGRAM_ADDRESS, TOKEN_2022_PROGRAM_ADDRESS]) {
    const { value } = await rpcCall(() =>
      rpc.getTokenAccountsByOwner(custody, { programId }, { encoding: 'base64' }).send(),
    )
    for (const { pubkey, account } of value) {
      const data = accountDataBase64(account.data)
      pre.set(pubkey, { amount: tokenAccountAmount(data), data, owner: `${account.owner}` })
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
    const accountAddress = watched[i] as Address
    const account = accounts[i + 1]
    const before = pre.get(accountAddress)
    // A watched account ABSENT from the post-simulation is not "unchanged" —
    // the transaction may have closed it (CloseAccount drains lamports to an
    // arbitrary destination while the token balance reads as untouched).
    // Treating null as unchanged was the H-1 blind spot: fail closed.
    if (!account) throw new Error(`custody simulation closed or removed token account ${accountAddress}`)
    // The account must still be owned by the SAME token program — an owner
    // reassignment hands the funds to an arbitrary program.
    if (`${account.owner}` !== before?.owner) {
      throw new Error(`custody simulation changed the owner of ${accountAddress}`)
    }
    const postData = accountDataBase64(account.data)
    // Delegate, freeze-state and close-authority must not move: an approved
    // delegate or a close authority survives this transaction and can drain
    // or lock the account afterwards.
    if (
      accountSlice(postData, TOKEN_DELEGATE_RANGE) !== accountSlice(before?.data, TOKEN_DELEGATE_RANGE) ||
      accountSlice(postData, TOKEN_CLOSE_AUTHORITY_RANGE) !== accountSlice(before?.data, TOKEN_CLOSE_AUTHORITY_RANGE)
    ) {
      throw new Error(`custody simulation changed delegate or close authority on ${accountAddress}`)
    }
    if (postData && before?.data) {
      const postBytes = Uint8Array.from(atob(postData), (char) => char.charCodeAt(0))
      if (postBytes.length > TOKEN_STATE_OFFSET && postBytes[TOKEN_STATE_OFFSET] === 2) {
        throw new Error(`custody simulation froze token account ${accountAddress}`)
      }
    }
    const debit = (before?.amount ?? 0n) - tokenAccountAmount(postData)
    if (debit <= 0n) continue
    const allowed = guard.maxDebits?.get(accountAddress) ?? 0n
    if (debit > allowed) {
      throw new Error(`custody simulation debits ${debit} from ${accountAddress} (allowed ${allowed})`)
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
  // No in-request sweep: the keeper cron (`POST /fims/custodial/sweep`)
  // moves the float excess on its own cadence — spending another ~30 s of
  // confirmation inside a member-facing request is what made the whole
  // flow timeout-prone. The backing is safe in custody until then.
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
  const units = envBigint(FLOAT_ENV[product], FLOAT_DEFAULT_UNITS)
  return units * (config?.units ?? 1_000_000n)
}

// Pure sweep decision: above the float target, move the excess; at or below,
// nothing to do. Exported for tests.
export function sweepAmount(balance: bigint, target: bigint): bigint {
  return balance > target ? balance - target : 0n
}

async function tokenBalanceOf(tokenAccount: Address): Promise<bigint> {
  const rpc = createSolanaRpc(rpcUrl())
  return tokenBalance(rpc, tokenAccount)
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
  const amount = sweepAmount(await tokenBalanceOf(custodyAta), floatTarget(product))
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
  yieldUnreadable: boolean
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
    const float = await tokenBalanceOf(custodyAta)
    const vaultBalance = vaultAta ? await tokenBalanceOf(vaultAta).catch(() => 0n) : 0n
    // Backing parked in the yield venue (jlEURC, Kamino collateral tokens)
    // still backs the product — without it the monitor alerts "unbacked"
    // whenever yield placement is active. The position token ≈ 1:1 backing
    // (reads slightly less than the true total as it accrues — safe side).
    let yieldBalance = 0n
    let yieldUnreadable = false
    const yieldAsset = process.env[`FIMS_${product === 'fims-eur' ? 'EUR' : 'USD'}_YIELD_ASSET`]
    if (yieldAsset) {
      try {
        const yieldMint = address(yieldAsset)
        const yieldProgram = await mintProgram(yieldMint)
        yieldBalance = await tokenBalanceOf(await ata(yieldMint, signer.address, yieldProgram))
      } catch {
        // An unreadable position counts as zero for health (alert side), but
        // is flagged so monitors can tell "RPC down" from "unbacked" (L-9).
        yieldUnreadable = true
      }
    }
    const backingTotal = float + vaultBalance + yieldBalance
    const supplyUnits = BigInt(supply.amount)
    const price = prices[config.symbol] ?? 0
    // Exact scaled arithmetic (L-8): Number(supply) loses digits beyond 2^53,
    // which could round `required` DOWN and report a false "healthy". Scale
    // the price to 1e9 and ceil-divide — always errs toward requiring MORE
    // backing, never less.
    const required = price > 0 ? (supplyUnits * BigInt(Math.ceil(price * 1e9)) + 999_999_999n) / 1_000_000_000n : 0n
    rows.push({
      backingTotal: backingTotal.toString(),
      float: float.toString(),
      floatTarget: floatTarget(product).toString(),
      healthy: backingTotal >= required,
      product,
      supply: supplyUnits.toString(),
      vault: vaultBalance.toString(),
      yieldUnreadable,
    })
  }
  return rows
}

// Backing units a redeem can actually source right now: the custody float
// plus, when a yield venue is configured, the position balance it can
// withdraw from. Below the float target, every unit above `float` still
// needs a venue withdrawal inside the redeem transaction.
export async function redeemLiquidity(product: FimsWrappedProduct): Promise<bigint> {
  const config = wrappedProductConfig(product)
  if (!config) throw new Error(`${product} mint is not configured`)
  const signer = await custodialSigner()
  const backingProgram = await mintProgram(config.backingMint)
  const backingCustodyAta = await ata(config.backingMint, signer.address, backingProgram)
  let available = await tokenBalanceOf(backingCustodyAta)
  if (yieldConfigured(product)) {
    const positionAta = await yieldPositionAta(product, signer.address).catch(() => null)
    if (positionAta) available += await tokenBalanceOf(positionAta).catch(() => 0n)
  }
  return available
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
  // With a yield venue configured, the withdraw instructions inside the
  // transaction pull `backingUnits` into the float first — the float alone
  // does not need to cover the redeem (audit M-4). Without a venue the
  // float is the only source and a shortfall must queue, not silently fail.
  if (backingVault() && !yieldConfigured(product)) {
    const float = await tokenBalanceOf(backingCustodyAta)
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
