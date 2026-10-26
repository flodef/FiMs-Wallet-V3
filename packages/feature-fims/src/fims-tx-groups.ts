import type { FimsTransaction } from './fims-api.ts'
import { getFimsTransactionType } from './fims-transaction-type.ts'

// A conversion is written as TWO rows sharing one requestId — the debit
// (`R`, amount < 0) and the credit (`R:credit`) — or, for legacy rows
// predating request_id, as two adjacent rows with opposite movements at the
// same timestamp. The UI shows one "from → to" line per operation.
export interface FimsTxGroup {
  // Debit leg first, credit leg second for conversions; single row otherwise.
  legs: [FimsTransaction, ...FimsTransaction[]]
}

const CREDIT_SUFFIX = ':credit'

const isConversion = (tx: FimsTransaction) => getFimsTransactionType(tx) === 'conversion'

// Legacy pairs: same timestamp, opposite movement signs, and the credit
// equal to the debit minus the operating fee — within 10% to absorb the
// fee and rounding on imported rows.
function legacyPartner(debit: FimsTransaction, candidates: FimsTransaction[]): FimsTransaction | undefined {
  const debitEur = Math.abs(debit.movement)
  return candidates.find(
    (tx) =>
      tx.date === debit.date &&
      Math.sign(tx.movement) !== Math.sign(debit.movement) &&
      Math.abs(tx.movement) > 0 &&
      Math.abs(tx.movement) / debitEur > 0.9 &&
      Math.abs(tx.movement) / debitEur <= 1.001,
  )
}

export function groupFimsTransactions(rows: FimsTransaction[]): FimsTxGroup[] {
  const byRequestId = new Map<string, FimsTransaction>()
  for (const tx of rows) {
    if (tx.requestId) byRequestId.set(tx.requestId, tx)
  }
  const used = new Set<number>()
  const groups: FimsTxGroup[] = []
  for (const tx of rows) {
    if (used.has(tx.id)) continue
    used.add(tx.id)
    if (!isConversion(tx)) {
      groups.push({ legs: [tx] })
      continue
    }
    // Exact pair first: the credit leg carries `${requestId}:credit`.
    const base = tx.requestId?.endsWith(CREDIT_SUFFIX) ? tx.requestId.slice(0, -CREDIT_SUFFIX.length) : tx.requestId
    const linked = base
      ? [byRequestId.get(base), byRequestId.get(`${base}${CREDIT_SUFFIX}`)].find(
          (other) => other && other.id !== tx.id && !used.has(other.id),
        )
      : undefined
    const partner =
      linked ??
      (tx.movement < 0
        ? legacyPartner(
            tx,
            rows.filter((o) => !used.has(o.id) && o.id !== tx.id && isConversion(o) && !o.requestId),
          )
        : undefined)
    if (!partner) {
      groups.push({ legs: [tx] })
      continue
    }
    used.add(partner.id)
    const [debit, credit] = tx.movement < 0 ? [tx, partner] : [partner, tx]
    groups.push({ legs: [debit, credit] })
  }
  return groups
}
