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

const ALLOWED_PROGRAM_IDS = new Set<string>([
  '11111111111111111111111111111111', // System
  'ComputeBudget111111111111111111111111111111',
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', // SPL Token
  'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb', // Token-2022
  'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL', // Associated Token
  'AddressLookupTab1e1111111111111111111111111',
  'Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo',
  'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr',
  JUPITER_AGGREGATOR_V6,
  JUPITER_TRIGGER,
  JUPITER_TRIGGER_V2,
])

// Extra lamports head-room on top of the expected spend: fee + rent-exempt
// deposits for the ATAs Jupiter may create inside the swap (~0.002 SOL each).
const SOL_OUTFLOW_TOLERANCE = 6_000_000n // 0.006 SOL

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
export function assertJupiterTransactionSafe({
  account,
  expectedSpend,
  inspection,
}: {
  account: Address
  expectedSpend?: { amount: bigint; mint: Address } | undefined
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

  // Outflow budget per mint. SOL is tracked through the wallet's lamports;
  // a wSOL account owned by the wallet adds to the same native budget.
  const spendByMint = new Map<string, bigint>()
  if (expectedSpend) {
    spendByMint.set(expectedSpend.mint, expectedSpend.amount)
  }

  const walletSolChange =
    inspection.simulation.solBalanceChanges.find((change) => change.address === account)?.change ?? 0n
  const nativeTokenOutflow = inspection.simulation.tokenBalanceChanges
    .filter((change) => change.change < 0n && change.owner === account && change.mint === NATIVE_MINT)
    .reduce((total, change) => total - change.change, 0n)
  const nativeOutflow = (walletSolChange < 0n ? -walletSolChange : 0n) + nativeTokenOutflow
  const nativeSpendBudget = (expectedSpend?.mint === NATIVE_MINT ? expectedSpend.amount : 0n) + SOL_OUTFLOW_TOLERANCE
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
}
