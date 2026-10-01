import type { FimsTransaction, FimsTransactionType } from './fims-api.ts'

// V2 rule: a transaction is a donation/payment when the `cost` column equals the
// `movement` (same sign — cost is negative on withdrawals). Stored `type` wins when set.
export function getFimsTransactionType(
  transaction: Pick<FimsTransaction, 'cost' | 'movement' | 'type'>,
): FimsTransactionType {
  if (transaction.type) {
    return transaction.type
  }
  const movement = transaction.movement ?? 0
  const special = Math.abs(movement - (transaction.cost ?? 0)) < 0.01
  return movement > 0 ? (special ? 'donation' : 'deposit') : special ? 'payment' : 'withdrawal'
}
