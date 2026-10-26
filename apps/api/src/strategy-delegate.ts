// cspell:ignore ABCDEFGHJKLMNPQRSTUVWXY Zabcdefghijkmnopqrstuvwxyz
// Strategy delegate — the off-chain keeper for the fims-strategy vault.
//
// Solana programs cannot wake themselves: this service turns an on-chain
// deposit record into a finished position. A cron (cron-job.org) POSTs
// /fims/strategy/delegate-run every minute; each pass:
//
//   1. scans `member_deposit` PDAs with `pending > 0`
//   2. issues share tokens 1:1 (`issue_shares`) FIRST — the member's payout
//      never depends on the protocol placements succeeding
//   3. places the collateral: jl_operate (Jupiter Lend operate via the
//      instructions API), swap borrow→stable (Jupiter swap-instructions),
//      kamino_flow supply (Kamino KTX) — every step is recorded in
//      `strategy_ops` so a failed pass is retried and visible
//
// The hot key lives in STRATEGY_DELEGATE_KEYPAIR (same format as
// CUSTODIAL_KEYPAIR). It can only drive whitelisted CPIs — the program's
// post-conditions do the safety work, not this service.
import { timingSafeEqual } from 'node:crypto'
import {
  type Address,
  address,
  appendTransactionMessageInstructions,
  type Base64EncodedBytes,
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
import { fetchMint, getCreateAssociatedTokenIdempotentInstruction } from '@solana-program/token'
import { and, desc, eq, isNotNull, sql } from 'drizzle-orm'
import { keeperLocks, prices, strategyOps, userHistoric } from './db/schema.js'
import type { Db } from './db/service.js'
import { envInt } from './env.js'
import { createBackendSigner } from './signer.js'
import { fetchProviderInstructions, rpcCall, rpcUrl, tokenBalance } from './solana-util.js'

import {
  addressToBytes,
  anchorDisc,
  borshBytes,
  bytes,
  concat,
  encodeBase58,
  i64,
  type MemberDepositParsed,
  memberAta,
  memberDepositDisc,
  POSITION_LEN,
  POSITION_MINT_OFF,
  parseMemberDeposit,
  parseStrategyState,
  positionPda,
  RO,
  RW,
  SIGNER,
  STRATEGY_PROGRAM_ID,
  type StrategyConfigParsed,
  type StrategyStateParsed,
  statePda,
  u8,
  u64,
  vaultAta,
  vaultPda,
} from './strategy-codec.js'

export { STRATEGY_PROGRAM_ID } from './strategy-codec.js'

const TOKEN_PROGRAM_ID = address('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA')
const TOKEN_2022_PROGRAM_ID = address('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb')

// mint → owning token program (legacy SPL or Token-2022, e.g. FLiP), cached
// per process — ATA derivations and the token_program metas depend on it.
const tokenProgramCache = new Map<string, Address>()
export async function mintTokenProgram(rpc: ReturnType<typeof createSolanaRpc>, mint: Address): Promise<Address> {
  const cached = tokenProgramCache.get(mint)
  if (cached) return cached
  const info = await fetchMint(rpc, mint)
  const program = info.programAddress
  if (program !== TOKEN_PROGRAM_ID && program !== TOKEN_2022_PROGRAM_ID) {
    throw new Error(`mint ${mint} lives under unexpected program ${program}`)
  }
  tokenProgramCache.set(mint, program)
  return program
}

const JUPITER_API = () => process.env['JUPITER_API'] ?? 'https://lite-api.jup.ag'
const KAMINO_KTX_API = () => process.env['KAMINO_KTX_API'] ?? 'https://api.kamino.finance/ktx'
// Fraction of collateral value borrowed per deposit, in bps (default 50%).
const targetLtvBps = () => envInt('STRATEGY_LTV_BPS', 5000)
// Pending deposits older than this make /strategy/status return unhealthy.
const alertAgeSecs = () => envInt('STRATEGY_ALERT_SECS', 900)
const kaminoMarket = () => process.env['STRATEGY_KAMINO_MARKET'] ?? process.env['FIMS_USD_YIELD_MARKET']
const kaminoReserve = () => process.env['STRATEGY_KAMINO_RESERVE'] ?? process.env['FIMS_USD_YIELD_RESERVE']

// ---------------------------------------------------------------------------
// base58 + borsh helpers (kept sync so parsers stay trivially testable)
// ---------------------------------------------------------------------------

interface RawInstruction {
  programId: string
  accounts: { pubkey: string; isSigner: boolean; isWritable: boolean }[]
  data: string // base64
}

/** Outer ix for jl_operate/swap/kamino_flow: named ProtocolOp accounts, then
 *  the inner ix's accounts (all non-signer — cpi_whitelisted re-marks the
 *  vault), then the callee program as the LAST account. */
async function protocolIx(
  caller: Address,
  ixName: string,
  args: Uint8Array,
  inner: RawInstruction,
): Promise<Instruction> {
  return {
    accounts: [
      { address: caller, role: SIGNER },
      { address: await statePda(), role: RO },
      { address: await vaultPda(), role: RO },
      ...inner.accounts.map((a) => ({
        address: address(a.pubkey),
        role: a.isWritable ? RW : RO,
      })),
      { address: address(inner.programId), role: RO },
    ],
    data: concat([await anchorDisc(ixName), args, borshBytes(bytes(inner.data))]),
    programAddress: STRATEGY_PROGRAM_ID,
  }
}

export async function jlOperateIx(
  caller: Address,
  strategyIndex: number,
  colDelta: bigint,
  debtDelta: bigint,
  inner: RawInstruction,
): Promise<Instruction> {
  return protocolIx(caller, 'jl_operate', concat([u8(strategyIndex), i64(colDelta), i64(debtDelta)]), inner)
}

export async function swapIx(
  caller: Address,
  inMint: Address,
  outMint: Address,
  amount: bigint,
  minOut: bigint,
  inner: RawInstruction,
): Promise<Instruction> {
  return protocolIx(
    caller,
    'swap',
    concat([addressToBytes(inMint), addressToBytes(outMint), u64(amount), u64(minOut)]),
    inner,
  )
}

export async function kaminoFlowIx(
  caller: Address,
  strategyIndex: number,
  direction: 'supply' | 'withdraw',
  amount: bigint,
  inner: RawInstruction,
): Promise<Instruction> {
  return protocolIx(
    caller,
    'kamino_flow',
    concat([u8(strategyIndex), u8(direction === 'supply' ? 0 : 1), u64(amount)]),
    inner,
  )
}

/** issue_shares(amount): delegate pays share tokens to the deposit record's
 *  member ATA — destination is derived on-chain from the deposit PDA. */
export async function issueSharesIx(
  caller: Address,
  deposit: MemberDepositParsed,
  depositPda: Address,
  strategy: StrategyConfigParsed,
  amount: bigint,
  tokenProgram: Address,
): Promise<Instruction> {
  return {
    accounts: [
      { address: caller, role: SIGNER },
      { address: await statePda(), role: RO },
      { address: await vaultPda(), role: RW },
      { address: depositPda, role: RW },
      { address: await vaultAta(strategy.shareMint, tokenProgram), role: RW },
      { address: await memberAta(deposit.member, strategy.shareMint, tokenProgram), role: RW },
      { address: tokenProgram, role: RO },
      { address: strategy.shareMint, role: RO },
    ],
    data: concat([await anchorDisc('issue_shares'), u64(amount)]),
    programAddress: STRATEGY_PROGRAM_ID,
  }
}

// ---------------------------------------------------------------------------
// delegate signer + tx send (same pattern as custodial.ts)
// ---------------------------------------------------------------------------

function delegateSecretKey(): Uint8Array {
  const raw = process.env['STRATEGY_DELEGATE_KEYPAIR']
  if (!raw) throw new Error('STRATEGY_DELEGATE_KEYPAIR is not configured')
  const bytes = raw.trim().startsWith('[')
    ? Uint8Array.from(JSON.parse(raw) as number[])
    : Uint8Array.from(addressToBytes(raw.trim() as Address))
  if (bytes.length !== 64) throw new Error('STRATEGY_DELEGATE_KEYPAIR must be a 64-byte secret key')
  return bytes
}

let delegateSignerPromise: Promise<TransactionSigner> | undefined
function delegateSigner(): Promise<TransactionSigner> {
  delegateSignerPromise ??= createBackendSigner('STRATEGY_DELEGATE', delegateSecretKey)
  return delegateSignerPromise
}

async function sendDelegateTx(ixs: Instruction[]): Promise<Signature> {
  const signer = await delegateSigner()
  const rpc = createSolanaRpc(rpcUrl())
  const { value: latestBlockhash } = await rpcCall(() => rpc.getLatestBlockhash().send())
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (tx) => appendTransactionMessageInstructions(ixs, tx),
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
    if (status?.err) throw new Error(`delegate transaction failed: ${JSON.stringify(status.err)}`)
    if (status && (status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized')) {
      return signature
    }
    await new Promise((resolve) => setTimeout(resolve, 750))
  }
  throw new Error(`delegate transaction not confirmed: ${signature}`)
}

// ---------------------------------------------------------------------------
// chain reads
// ---------------------------------------------------------------------------

export async function readStrategyState(rpc = createSolanaRpc(rpcUrl())): Promise<StrategyStateParsed> {
  const stateAddr = await statePda()
  const res = await rpcCall(() => rpc.getAccountInfo(stateAddr, { encoding: 'base64' }).send())
  const data = res.value?.data
  if (!data) throw new Error('strategy state account not found — program not initialized?')
  return parseStrategyState(typeof data === 'string' ? bytes(data) : bytes(data[0]))
}

export interface PendingDeposit extends MemberDepositParsed {
  pda: Address
}

export async function listPendingDeposits(rpc = createSolanaRpc(rpcUrl())): Promise<PendingDeposit[]> {
  const disc = await memberDepositDisc()
  const accounts = await rpcCall(() =>
    rpc
      .getProgramAccounts(STRATEGY_PROGRAM_ID, {
        encoding: 'base64',
        filters: [
          {
            memcmp: {
              bytes: Buffer.from(disc).toString('base64') as Base64EncodedBytes,
              encoding: 'base64',
              offset: 0n,
            },
          },
        ],
      })
      .send(),
  )
  return accounts
    .map((a: { account: { data: unknown }; pubkey: Address }) => ({
      ...parseMemberDeposit(bytes((a.account.data as [string, string])[0] ?? (a.account.data as string))),
      pda: a.pubkey,
    }))
    .filter((d: PendingDeposit) => d.pending > 0n)
}

// ---------------------------------------------------------------------------
// protocol instruction providers — the same "return raw instructions" APIs
// the wallet already trusts for yield placement
// ---------------------------------------------------------------------------

async function fetchInstructions(url: string, payload: Record<string, unknown>): Promise<RawInstruction[]> {
  return (await fetchProviderInstructions(url, payload)) as RawInstruction[]
}

/** Jupiter Lend `operate` — the last instruction on the vaults program is the
 *  operate CPI; earlier instructions are account setup we rebuild ourselves. */
async function jupiterOperateInstruction(
  strategy: StrategyConfigParsed,
  vault: Address,
  colAmount: bigint,
  debtAmount: bigint,
): Promise<RawInstruction> {
  const ixs = await fetchInstructions(`${JUPITER_API()}/lend/v1/borrow/operate-instructions`, {
    colAmount: colAmount.toString(),
    debtAmount: debtAmount.toString(),
    positionId: Number(strategy.positionId),
    positionOwner: vault,
    signer: vault,
    vaultId: Number(strategy.vaultId),
  })
  const operate = [...ixs].reverse().find((ix) => ix.programId === strategy.vaultsProgram)
  if (!operate) throw new Error('operate-instructions returned no vaults-program instruction')
  return operate
}

/** Jupiter swap-instructions for USDT→USDG from the vault's perspective. */
async function jupiterSwapInstruction(
  vault: Address,
  inMint: Address,
  outMint: Address,
  amount: bigint,
  slippageBps: number,
): Promise<{ inner: RawInstruction; minOut: bigint }> {
  const quoteRes = await fetch(
    `${JUPITER_API()}/swap/v1/quote?inputMint=${inMint}&outputMint=${outMint}&amount=${amount}&slippageBps=${slippageBps}`,
  )
  if (!quoteRes.ok) throw new Error(`jupiter quote ${quoteRes.status}`)
  const quote = (await quoteRes.json()) as { otherAmountThreshold?: string }
  const ixs = await fetchInstructions(`${JUPITER_API()}/swap/v1/swap-instructions`, {
    quoteResponse: quote,
    userPublicKey: vault,
  })
  // The API may return the swap under `swapInstruction` or as the last entry.
  const swap = [...ixs].reverse().find((ix) => ix.accounts.some((a) => a.pubkey === vault && a.isSigner))
  if (!swap) throw new Error('swap-instructions returned no vault-signed instruction')
  // otherAmountThreshold is the slippage floor the program asserts on-chain —
  // a quote missing it would swap "any amount back", which is not a quote at
  // all but a donation to the pool.
  if (!quote.otherAmountThreshold || BigInt(quote.otherAmountThreshold) === 0n) {
    throw new Error('jupiter quote missing otherAmountThreshold — refusing to swap without a floor')
  }
  return { inner: swap, minOut: BigInt(quote.otherAmountThreshold) }
}

/** Kamino KTX deposit — returns the klend deposit instruction for the vault. */
async function kaminoDepositInstruction(vault: Address, amount: bigint, decimals: number): Promise<RawInstruction> {
  const market = kaminoMarket()
  const reserve = kaminoReserve()
  if (!market || !reserve) throw new Error('STRATEGY_KAMINO_MARKET / STRATEGY_KAMINO_RESERVE are not configured')
  const ixs = await fetchInstructions(`${KAMINO_KTX_API()}/klend/deposit-instructions`, {
    amount: `${Number(amount) / 10 ** decimals}`,
    market,
    reserve,
    wallet: vault,
  })
  const last = ixs[ixs.length - 1]
  if (!last) throw new Error('kamino returned no instructions')
  return last
}

// ---------------------------------------------------------------------------
// orchestration
// ---------------------------------------------------------------------------

export interface DelegatePassReport {
  deposits: {
    member: Address
    strategy: number
    pending: string
    issueSignature?: string
    opsSignatures?: string[]
    error?: string
  }[]
  skipped?: string
}

// A pass can outlive the 1-minute cron cadence — without a lock two isolates
// would race the same deposits and double-issue/double-place. The TTL lease
// self-heals: a crashed holder's lock expires instead of sticking forever.
const KEEPER_LEASE_MS = 5 * 60 * 1000

async function acquireKeeperLease(db: Db, name: string): Promise<string | null> {
  const owner = `${Date.now()}-${Math.random().toString(36).slice(2)}`
  const until = new Date(Date.now() + KEEPER_LEASE_MS)
  const rows = (
    await db.execute(sql`
      INSERT INTO keeper_locks (name, expires_at, owner) VALUES (${name}, ${until.toISOString()}, ${owner})
      ON CONFLICT (name) DO UPDATE SET expires_at = ${until.toISOString()}, owner = ${owner}
      WHERE keeper_locks.expires_at < NOW()
      RETURNING name
    `)
  ).rows as { name: string }[]
  return rows.length ? owner : null
}

async function releaseKeeperLease(db: Db, name: string, owner: string): Promise<void> {
  await db
    .update(keeperLocks)
    .set({ expiresAt: new Date(0) })
    .where(and(eq(keeperLocks.name, name), eq(keeperLocks.owner, owner)))
}

// Soft mutex for keeper-only jobs. Returns null when another isolate holds
// the lease — the caller skips its run this tick. Note the lease only
// serializes keeper work: anything else that can move the same rows still
// needs its own atomic transition.
export async function withKeeperLease<T>(db: Db, name: string, fn: () => Promise<T>): Promise<T | null> {
  const owner = await acquireKeeperLease(db, name)
  if (!owner) return null
  try {
    return await fn()
  } finally {
    await releaseKeeperLease(db, name, owner).catch((error) =>
      console.warn('keeper lease release failed — lease expires on its TTL', error),
    )
  }
}

/** One delegate pass: issue share tokens for every recorded deposit, then
 *  place the collateral through the protocol pipeline. Issuance runs FIRST —
 *  the member's 1:1 payout is a program-level guarantee and must not wait on
 *  Jupiter/Kamino availability. */
export async function runStrategyPass(db: Db): Promise<DelegatePassReport> {
  const result = await withKeeperLease(db, 'strategy-delegate', () => runStrategyPassUnlocked(db))
  return result ?? { deposits: [], skipped: 'another pass is running' }
}

async function runStrategyPassUnlocked(db: Db): Promise<DelegatePassReport> {
  const signer = await delegateSigner()
  const rpc = createSolanaRpc(rpcUrl())
  const state = await readStrategyState(rpc)
  if (state.delegate !== signer.address) {
    throw new Error(`delegate key mismatch: signer=${signer.address} state.delegate=${state.delegate}`)
  }
  if (state.paused) return { deposits: [], skipped: 'paused' }

  const deposits = await listPendingDeposits(rpc)
  const report: DelegatePassReport = { deposits: [] }

  // Recover legs whose shares were issued but placement failed: the member
  // already holds shares, so leaving the collateral unplaced is the failure
  // mode — not a reason to skip forever. One retry per hour per leg, a few
  // legs per pass so the queue drains without starving new deposits.
  const staleFailed = await db.query.strategyOps.findMany({
    limit: 5,
    where: and(
      eq(strategyOps.status, 'failed'),
      isNotNull(strategyOps.issueSignature),
      sql`${strategyOps.updatedAt} < NOW() - INTERVAL '1 hour'`,
    ),
  })
  for (const op of staleFailed) {
    const deposit = {
      member: address(op.member),
      pda: address(op.depositPda),
      pending: BigInt(op.collateralAmount),
      strategyIndex: op.strategyIndex,
    } as PendingDeposit
    const entry: DelegatePassReport['deposits'][number] = {
      ...(op.issueSignature ? { issueSignature: op.issueSignature } : {}),
      member: deposit.member,
      pending: op.collateralAmount,
      strategy: op.strategyIndex,
    }
    report.deposits.push(entry)
    const strategy = state.strategies[op.strategyIndex]
    if (!strategy) {
      entry.error = `retry: unknown strategy index ${op.strategyIndex}`
      await recordOp(db, deposit, 'failed', entry.error, op.issueSignature ?? undefined)
      continue
    }
    try {
      entry.opsSignatures = await placeCollateral(signer, strategy, op.strategyIndex, BigInt(op.collateralAmount))
      await recordOp(db, deposit, 'placed', undefined, op.issueSignature ?? undefined, entry.opsSignatures.join(','))
    } catch (error) {
      entry.error = `placement retry: ${error instanceof Error ? error.message : error}`
      await recordOp(db, deposit, 'failed', entry.error, op.issueSignature ?? undefined)
    }
  }

  for (const deposit of deposits) {
    const entry: DelegatePassReport['deposits'][number] = {
      member: deposit.member,
      pending: deposit.pending.toString(),
      strategy: deposit.strategyIndex,
    }
    report.deposits.push(entry)
    const strategy = state.strategies[deposit.strategyIndex]
    if (!strategy) {
      entry.error = `unknown strategy index ${deposit.strategyIndex}`
      await recordOp(db, deposit, 'failed', entry.error)
      continue
    }
    try {
      // 1. Issue shares 1:1 — creates the member's share ATA if missing.
      const shareTokenProgram = await mintTokenProgram(rpc, strategy.shareMint)
      entry.issueSignature = await sendDelegateTx([
        getCreateAssociatedTokenIdempotentInstruction({
          ata: await memberAta(deposit.member, strategy.shareMint, shareTokenProgram),
          mint: strategy.shareMint,
          owner: deposit.member,
          payer: signer,
          tokenProgram: shareTokenProgram,
        }),
        await issueSharesIx(signer.address, deposit, deposit.pda, strategy, deposit.pending, shareTokenProgram),
      ])
      await recordOp(db, deposit, 'issued', undefined, entry.issueSignature)
    } catch (error) {
      entry.error = `issue_shares: ${error instanceof Error ? error.message : error}`
      await recordOp(db, deposit, 'failed', entry.error)
      continue
    }
    try {
      entry.opsSignatures = await placeCollateral(signer, strategy, deposit.strategyIndex, deposit.pending)
      await recordOp(db, deposit, 'placed', undefined, entry.issueSignature, entry.opsSignatures.join(','))
    } catch (error) {
      entry.error = `placement: ${error instanceof Error ? error.message : error}`
      await recordOp(db, deposit, 'failed', entry.error, entry.issueSignature)
    }
  }
  return report
}

async function recordOp(
  db: Db,
  deposit: PendingDeposit,
  status: 'issued' | 'placed' | 'failed' | 'pending',
  error?: string,
  issueSignature?: string,
  opsSignature?: string,
): Promise<void> {
  await db
    .insert(strategyOps)
    .values({
      collateralAmount: deposit.pending.toString(),
      depositPda: deposit.pda,
      error: error ?? null,
      issueSignature: issueSignature ?? null,
      member: deposit.member,
      opsSignature: opsSignature ?? null,
      status,
      strategyIndex: deposit.strategyIndex,
    })
    .onConflictDoUpdate({
      set: {
        collateralAmount: deposit.pending.toString(),
        error: error ?? null,
        issueSignature: issueSignature ?? null,
        opsSignature: opsSignature ?? null,
        status,
        updatedAt: new Date(),
      },
      target: strategyOps.depositPda,
    })
}

/** jl_operate (+collateral, +debt) → swap borrow→stable → kamino supply. */
async function placeCollateral(
  signer: TransactionSigner,
  strategy: StrategyConfigParsed,
  strategyIndex: number,
  collateralAmount: bigint,
): Promise<Signature[]> {
  const signatures: Signature[] = []
  const vault = await vaultPda()
  const rpc = createSolanaRpc(rpcUrl())

  // Ensure the vault ATAs the ops need exist — idempotent, delegate-paid.
  const borrowTokenProgram = await mintTokenProgram(rpc, strategy.borrowMint)
  const stableTokenProgram = await mintTokenProgram(rpc, strategy.stableMint)
  await sendDelegateTx([
    getCreateAssociatedTokenIdempotentInstruction({
      ata: await vaultAta(strategy.borrowMint, borrowTokenProgram),
      mint: strategy.borrowMint,
      owner: vault,
      payer: signer,
      tokenProgram: borrowTokenProgram,
    }),
    getCreateAssociatedTokenIdempotentInstruction({
      ata: await vaultAta(strategy.stableMint, stableTokenProgram),
      mint: strategy.stableMint,
      owner: vault,
      payer: signer,
      tokenProgram: stableTokenProgram,
    }),
  ])

  // Borrow sizing: collateral units × price ratio × LTV, decimal-adjusted.
  const debtAmount = await borrowUnits(strategy, collateralAmount)
  const operate = await jupiterOperateInstruction(strategy, vault, collateralAmount, debtAmount)
  signatures.push(
    await sendDelegateTx([await jlOperateIx(signer.address, strategyIndex, collateralAmount, debtAmount, operate)]),
  )

  // Swap the borrowed stables → yield mint, min_out floored by the quote.
  const pair = { inMint: strategy.borrowMint, outMint: strategy.stableMint }
  const { inner, minOut } = await jupiterSwapInstruction(vault, pair.inMint, pair.outMint, debtAmount, 50)
  signatures.push(
    await sendDelegateTx([await swapIx(signer.address, pair.inMint, pair.outMint, debtAmount, minOut, inner)]),
  )

  // Supply whatever stable arrived into Kamino.
  const stableBalance = await strategyTokenBalance(await vaultAta(strategy.stableMint, stableTokenProgram))
  const kamino = await kaminoDepositInstruction(vault, stableBalance, await mintDecimals(strategy.stableMint))
  signatures.push(
    await sendDelegateTx([await kaminoFlowIx(signer.address, strategyIndex, 'supply', stableBalance, kamino)]),
  )
  return signatures
}

async function strategyTokenBalance(ata: Address): Promise<bigint> {
  const rpc = createSolanaRpc(rpcUrl())
  return tokenBalance(rpc, ata)
}

async function mintDecimals(mint: Address): Promise<number> {
  const rpc = createSolanaRpc(rpcUrl())
  const res = await rpcCall(() => rpc.getAccountInfo(mint, { encoding: 'base64' }).send())
  const raw = res.value?.data
  if (!raw) throw new Error(`mint ${mint} not found`)
  const data = typeof raw === 'string' ? bytes(raw) : bytes(raw[0])
  return data[44] ?? 0 // SPL mint decimals offset
}

/** Collateral value → borrow-mint units at the configured LTV. Prices come
 *  from the Jupiter price API so JUPSOL→USDT is valued at market. */
async function borrowUnits(strategy: StrategyConfigParsed, collateralAmount: bigint): Promise<bigint> {
  const res = await fetch(`${JUPITER_API()}/price/v3?ids=${strategy.collateralMint},${strategy.borrowMint}`)
  if (!res.ok) throw new Error(`price api ${res.status}`)
  const json = (await res.json()) as Record<string, { usdPrice?: number }>
  const colPrice = json[strategy.collateralMint]?.usdPrice
  const debtPrice = json[strategy.borrowMint]?.usdPrice
  if (!colPrice || !debtPrice) throw new Error('price api missing mint prices')
  const [decCol, decDebt] = await Promise.all([
    mintDecimals(strategy.collateralMint),
    mintDecimals(strategy.borrowMint),
  ])
  const value = Number(collateralAmount) / 10 ** decCol
  const debt = (value * colPrice * targetLtvBps()) / 10_000 / debtPrice
  return BigInt(Math.floor(debt * 10 ** decDebt))
}

// ---------------------------------------------------------------------------
// health — cron-job.org alerts on any non-200
// ---------------------------------------------------------------------------

export interface StrategyHealth {
  delegate: Address | undefined
  delegateLamports: number | undefined
  failedOps: number
  healthy: boolean
  issues: string[]
  pendingDeposits: number
  staleDeposits: number
}

export async function strategyHealth(db: Db): Promise<StrategyHealth> {
  const issues: string[] = []
  let delegate: Address | undefined
  let delegateLamports: number | undefined
  let pendingDeposits = 0
  let staleDeposits = 0

  try {
    const rpc = createSolanaRpc(rpcUrl())
    const state = await readStrategyState(rpc)
    delegate = state.delegate
    if (state.paused) issues.push('strategy paused')
    delegateLamports = Number((await rpc.getBalance(state.delegate).send()).value)
    if (delegateLamports < 1_000_000) issues.push(`delegate low on fees: ${delegateLamports} lamports`)

    const pending = await listPendingDeposits(rpc)
    pendingDeposits = pending.length
    const now = Date.now()
    for (const dep of pending) {
      const row = await db.query.strategyOps.findFirst({ where: eq(strategyOps.depositPda, dep.pda) })
      const ageSec = row ? (now - new Date(row.firstSeenAt).getTime()) / 1000 : 0
      if (!row || ageSec > alertAgeSecs()) staleDeposits++
    }
    if (staleDeposits > 0) issues.push(`${staleDeposits} deposit(s) pending longer than ${alertAgeSecs()}s`)

    // Position-account health: right owner, expected minimum size, and the
    // position NFT mint still where the program reads it. An upstream
    // upgrade that changed the layout turns delegate ops into reverts —
    // surface it here instead.
    for (const strategy of state.strategies) {
      const pda = await positionPda(strategy)
      const position = await rpc.getAccountInfo(pda, { encoding: 'base64' }).send()
      if (!position.value) {
        issues.push(`strategy ${strategy.positionId}: position account missing`)
        continue
      }
      if (position.value.owner !== strategy.vaultsProgram) {
        issues.push(`strategy ${strategy.positionId}: position owner changed`)
        continue
      }
      const data = Buffer.from(position.value.data[0], 'base64')
      if (data.length < POSITION_LEN) {
        issues.push(`strategy ${strategy.positionId}: position shrank to ${data.length}B`)
      } else if (encodeBase58(data.subarray(POSITION_MINT_OFF, POSITION_MINT_OFF + 32)) !== strategy.positionNftMint) {
        issues.push(`strategy ${strategy.positionId}: position mint field drifted`)
      }
    }
  } catch (error) {
    issues.push(`chain read failed: ${error instanceof Error ? error.message : error}`)
  }

  const failedOps = await db.query.strategyOps.findMany({ where: eq(strategyOps.status, 'failed') })
  if (failedOps.length > 0) issues.push(`${failedOps.length} failed op(s)`)

  // Data freshness: the community page and member P&L read `prices` and
  // `user_historic` — a silent ingest failure used to freeze them for weeks.
  // Both are fed ~daily (price sync twice a day, historic once); anything
  // older than two days means the feed is broken, not just late.
  const FRESHNESS_MS = 2 * 24 * 60 * 60 * 1000
  const now = Date.now()
  const [latestPrice, latestHistoric] = await Promise.all([
    db.query.prices.findFirst({ orderBy: desc(prices.date) }),
    db.query.userHistoric.findFirst({ orderBy: desc(userHistoric.date) }),
  ])
  if (!latestPrice || now - latestPrice.date.getTime() > FRESHNESS_MS) {
    issues.push(`prices stale: last ${latestPrice?.date.toISOString().slice(0, 10) ?? 'never'}`)
  }
  if (!latestHistoric || now - latestHistoric.date.getTime() > FRESHNESS_MS) {
    issues.push(`user_historic stale: last ${latestHistoric?.date.toISOString().slice(0, 10) ?? 'never'}`)
  }

  return {
    delegate,
    delegateLamports,
    failedOps: failedOps.length,
    healthy: issues.length === 0,
    issues,
    pendingDeposits,
    staleDeposits,
  }
}

/** Shared-secret gate for the cron endpoints — the signer endpoints use the
 *  wallet signature; these are operator-only automation hooks. */
export function cronAuthorized(header: string | null): boolean {
  const secret = process.env['STRATEGY_DELEGATE_SECRET']
  if (!secret || !header) return false
  const a = Buffer.from(header)
  const b = Buffer.from(secret)
  return a.length === b.length && timingSafeEqual(a, b)
}
