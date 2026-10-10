import type { Address } from '@solana/kit'
import { NATIVE_MINT } from '@workspace/solana-client/constants'
import type { inspectWireTransaction } from '@workspace/solana-client/inspect-wire-transaction'

type Inspection = Awaited<ReturnType<typeof inspectWireTransaction>>

// Programs a legitimate Jupiter swap / trigger transaction is allowed to
// invoke. Anything else means the transaction was tampered with or crafted to
// drain the wallet.
const JUPITER_AGGREGATOR_V6 = 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4'
const JUPITER_TRIGGER = 'jupoNjAxXgZ4rjzxzPMP4oxduvQsQtZzyknqvzCNrNu'
const JUPITER_TRIGGER_V2 = 'j1o2qRpjcyUwEvwtcfhEQefh773ZgjxcVRry7LDqg5X'

const SYSTEM_PROGRAM = '11111111111111111111111111111111'
const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'
const TOKEN_2022_PROGRAM = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'
// FiMs strategy vault — the swap+deposit transaction (buy FSOL/FLiP) ends
// with a `deposit` instruction that moves the swap output into the vault.
const FIMS_STRATEGY_PROGRAM = 'AtmC4gPAEZ1r4fD698mDaCpGEC5WZN5f4z55zscsdVmS'

const ALLOWED_PROGRAM_IDS = new Set<string>([
  SYSTEM_PROGRAM,
  'ComputeBudget111111111111111111111111111111',
  TOKEN_PROGRAM,
  TOKEN_2022_PROGRAM,
  'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL', // Associated Token
  'AddressLookupTab1e1111111111111111111111111',
  'Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo',
  'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr',
  JUPITER_AGGREGATOR_V6,
  JUPITER_TRIGGER,
  JUPITER_TRIGGER_V2,
  FIMS_STRATEGY_PROGRAM,
])

// Extra lamports head-room on top of the expected spend: fee + rent-exempt
// deposits for the ATAs Jupiter may create inside the swap (~0.002 SOL each).
const SOL_OUTFLOW_TOLERANCE = 6_000_000n // 0.006 SOL

// SPL Token / Token-2022 top-level discriminators that hand control of a
// token account to someone else. They change no balance, so the simulation
// delta alone would never see them — reject at the instruction level.
// Approve (4), SetAuthority (6), ApproveChecked (13), and for token-2022 the
// shared variants (revocable PermanentDelegate lives at 26, but any owner
// change is already caught post-state).
const TOKEN_IX_APPROVE = 4
const TOKEN_IX_SET_AUTHORITY = 6
const TOKEN_IX_CLOSE_ACCOUNT = 9
const TOKEN_IX_APPROVE_CHECKED = 13

// System-program instruction types (u32 LE discriminator). A legitimate
// Jupiter transaction only ever creates accounts (0) or moves lamports (2);
// Assign (1), Allocate (8), AllocateWithSeed (9), TransferWithSeed (10),
// AssignWithSeed (11) and the nonce variants all rewrite the wallet's own
// account or move lamports with an opaque seed.
const ALLOWED_SYSTEM_IX_TYPES = new Set([0, 2])

export class JupiterInspectionError extends Error {
  constructor(reason: string) {
    super(`Jupiter transaction rejected by local inspection: ${reason}`)
    this.name = 'JupiterInspectionError'
  }
}

// Checks a decoded+simulated Jupiter transaction before signing. Throws
// JupiterInspectionError on any anomaly — callers must not sign in that case.
//
// expectedSpend lists mints the transaction is allowed to take from the
// wallet (e.g. the swap's inputMint/inAmount). Anything else leaving an
// account owned by the wallet is treated as a drain attempt.
// expectedReceive is the minimum the wallet must actually get back
// (e.g. the quote's otherAmountThreshold of outputMint): a transaction that
// spends correctly but pays the wallet less than promised is rejected too.
export function assertJupiterTransactionSafe({
  account,
  expectedSpend,
  expectedReceive,
  expectedReceiveOwner,
  extraSpends,
  inspection,
}: {
  account: Address
  expectedSpend?: { amount: bigint; mint: Address } | undefined
  expectedReceive?: { amount: bigint; mint: Address } | undefined
  // Extra owner whose token accounts count toward expectedReceive (e.g. the
  // strategy vault: the deposit moves the output there instead of leaving
  // it in the wallet).
  expectedReceiveOwner?: Address | undefined
  // Additional outflow budgets (e.g. the swap+deposit flow also moves the
  // swap output mint out of the wallet into the strategy vault).
  extraSpends?: { amount: bigint; mint: Address }[] | undefined
  inspection: Inspection
}) {
  if (inspection.feePayer !== account) {
    throw new JupiterInspectionError(`fee payer ${inspection.feePayer ?? 'none'} is not the wallet`)
  }
  const preSigned = new Set(inspection.alreadySignedBy)
  for (const signer of inspection.requiredSigners) {
    if (signer !== account && !preSigned.has(signer)) {
      throw new JupiterInspectionError(`unexpected required signer ${signer}`)
    }
  }
  const unknownPrograms = inspection.programIds.filter((id) => !ALLOWED_PROGRAM_IDS.has(id))
  if (unknownPrograms.length) {
    throw new JupiterInspectionError(`unknown program(s): ${unknownPrograms.join(', ')}`)
  }
  if (inspection.simulation.status === 'failure') {
    throw new JupiterInspectionError(`simulation failed: ${JSON.stringify(inspection.simulation.error)}`)
  }
  if (!inspection.simulation.accountsReliable) {
    // No deltas without both account states: fail closed rather than let a
    // flaky RPC turn the balance budget into a rubber stamp.
    throw new JupiterInspectionError('simulated account states are incomplete')
  }

  // Instruction-level rejections: effects that move no lamports and so stay
  // invisible to any balance diff (delegates, authority changes, closes to
  // a foreign destination, wallet account reassignment).
  for (const ix of inspection.instructions) {
    if (ix.hasUnresolvedAccounts || !ix.programId) {
      throw new JupiterInspectionError('instruction has unresolvable account references')
    }
    if (ix.programId === TOKEN_PROGRAM || ix.programId === TOKEN_2022_PROGRAM) {
      const instructionType = ix.data[0]
      if (instructionType === TOKEN_IX_APPROVE || instructionType === TOKEN_IX_APPROVE_CHECKED) {
        throw new JupiterInspectionError('approve instruction would delegate wallet funds')
      }
      if (instructionType === TOKEN_IX_SET_AUTHORITY) {
        throw new JupiterInspectionError('set-authority instruction would hand over an account')
      }
      if (instructionType === TOKEN_IX_CLOSE_ACCOUNT) {
        // CloseAccount accounts = [account, destination, authority]: the
        // lamports must come back to the wallet itself.
        const destination = ix.accountAddresses[1]
        if (destination !== account) {
          throw new JupiterInspectionError(`close-account pays ${destination ?? 'unknown'} instead of the wallet`)
        }
      }
    }
    if (ix.programId === SYSTEM_PROGRAM) {
      const type = ix.data.length >= 4 ? new DataView(ix.data.buffer, ix.data.byteOffset).getUint32(0, true) : -1
      if (!ALLOWED_SYSTEM_IX_TYPES.has(type)) {
        throw new JupiterInspectionError(`unsupported system instruction type ${type}`)
      }
    }
  }

  // The wallet's own system account must not be reassigned to another
  // program owner (System::Assign is invisible to balance diffs).
  if (inspection.simulation.walletOwnerAfter !== SYSTEM_PROGRAM) {
    throw new JupiterInspectionError(
      `wallet account owner changed to ${inspection.simulation.walletOwnerAfter ?? 'closed'}`,
    )
  }

  const walletSolChange =
    inspection.simulation.solBalanceChanges.find((change) => change.address === account)?.change ?? 0n

  // Post-state invariants on token accounts the wallet owns — before OR
  // after the transaction: ownership hand-over, leftover delegates, foreign
  // close authorities, and destroys. An account created mid-transaction for
  // the wallet (a fresh ATA) is covered too: a crafted tx could otherwise
  // plant a delegate or foreign close authority on it at creation and drain
  // it later. A legit wSOL unwrap destroys the account but sends its
  // lamports back to the wallet — anything else is a drain.
  for (const row of inspection.simulation.tokenAccounts) {
    if (row.ownerBefore !== account && row.ownerAfter !== account) {
      continue
    }
    if (row.destroyed) {
      if (row.mint !== NATIVE_MINT) {
        throw new JupiterInspectionError(`token account ${row.account} (${row.mint}) is closed`)
      }
      if (walletSolChange <= 0n) {
        throw new JupiterInspectionError(`wSOL account ${row.account} closed without returning lamports`)
      }
      continue
    }
    if (row.ownerAfter !== account) {
      throw new JupiterInspectionError(`token account ${row.account} ownership changed to ${row.ownerAfter ?? 'none'}`)
    }
    if (row.delegateAfter) {
      throw new JupiterInspectionError(`delegate set on token account ${row.account}`)
    }
    if (row.closeAuthorityAfter && row.closeAuthorityAfter !== account) {
      throw new JupiterInspectionError(`close authority of ${row.account} changed to ${row.closeAuthorityAfter}`)
    }
  }

  // Outflow budget per mint. SOL is tracked through the wallet's lamports;
  // a wSOL account owned by the wallet adds to the same native budget.
  const spendByMint = new Map<string, bigint>()
  if (expectedSpend) {
    spendByMint.set(expectedSpend.mint, expectedSpend.amount)
  }
  for (const extra of extraSpends ?? []) {
    spendByMint.set(extra.mint, (spendByMint.get(extra.mint) ?? 0n) + extra.amount)
  }

  const nativeTokenOutflow = inspection.simulation.tokenBalanceChanges
    .filter((change) => change.change < 0n && change.owner === account && change.mint === NATIVE_MINT)
    .reduce((total, change) => total - change.change, 0n)
  const nativeOutflow = (walletSolChange < 0n ? -walletSolChange : 0n) + nativeTokenOutflow
  const nativeSpendBudget =
    (expectedSpend?.mint === NATIVE_MINT ? expectedSpend.amount : 0n) +
    (extraSpends ?? [])
      .filter((extra) => extra.mint === NATIVE_MINT)
      .reduce((total, extra) => total + extra.amount, 0n) +
    SOL_OUTFLOW_TOLERANCE
  if (nativeOutflow > nativeSpendBudget) {
    throw new JupiterInspectionError(`SOL outflow ${nativeOutflow} exceeds expected ${nativeSpendBudget}`)
  }

  for (const change of inspection.simulation.tokenBalanceChanges) {
    if (change.change >= 0n || change.owner !== account || change.mint === NATIVE_MINT) continue
    const budget = spendByMint.get(change.mint) ?? 0n
    if (-change.change > budget) {
      throw new JupiterInspectionError(`token outflow of ${change.mint}: ${-change.change} exceeds ${budget}`)
    }
  }

  if (expectedReceive) {
    // The wallet (or an explicitly allowed extra owner like the strategy
    // vault) must actually receive what was promised: a correct spend means
    // nothing if the output lands on another account or is shrunk to dust
    // (minOut set to zero lets a sandwich strip the whole spread).
    const countsTowardReceive = (owner: Address | undefined) =>
      owner === account || (expectedReceiveOwner !== undefined && owner === expectedReceiveOwner)
    if (expectedReceive.mint === NATIVE_MINT) {
      const wsolInflow = inspection.simulation.tokenBalanceChanges
        .filter((change) => change.change > 0n && countsTowardReceive(change.owner) && change.mint === NATIVE_MINT)
        .reduce((total, change) => total + change.change, 0n)
      const nativeInflow = (walletSolChange > 0n ? walletSolChange : 0n) + wsolInflow
      if (nativeInflow < expectedReceive.amount) {
        throw new JupiterInspectionError(`SOL inflow ${nativeInflow} below expected minimum ${expectedReceive.amount}`)
      }
    } else {
      const inflow = inspection.simulation.tokenBalanceChanges
        .filter(
          (change) => change.change > 0n && countsTowardReceive(change.owner) && change.mint === expectedReceive.mint,
        )
        .reduce((total, change) => total + change.change, 0n)
      if (inflow < expectedReceive.amount) {
        throw new JupiterInspectionError(
          `${expectedReceive.mint} inflow ${inflow} below expected minimum ${expectedReceive.amount}`,
        )
      }
    }
  }
}
