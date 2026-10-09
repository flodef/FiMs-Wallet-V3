import type { FimsTransaction, FimsTransactionType } from './fims-api.ts'
import { getFimsTransactionType } from './fims-transaction-type.ts'

// Rows whose movement is a gift value, not contributed capital (movement ≈
// cost convention). Donations/payments are excluded from the basis: their
// value left the member's position without being a cash flow.
const NON_CAPITAL_TYPES: FimsTransactionType[] = ['donation', 'payment']

// Legacy spreadsheet rule: a member's gains are the current total value minus
// the net contributed cash (Σ movements of non-gift rows — deposits in,
// withdrawals out), so gains realized through withdrawals DO count. Position
// cost basis (user_historic.invested) would hide them: when units are sold,
// both the units and their basis drop together.
// The tontine debt is the tontine rate (min 10%) of those gains minus what
// was already given (donation rows + embedded donation_amount shares).
export function computeFimsDebt(currentTotal: number, transactions: FimsTransaction[], tontineRate: number): number {
  const netContributed = transactions.reduce(
    (sum, tx) => (NON_CAPITAL_TYPES.includes(getFimsTransactionType(tx)) ? sum : sum + (tx.movement ?? 0)),
    0,
  )
  const pnl = currentTotal - netContributed
  if (pnl <= 0) return 0
  const donated = transactions.reduce((sum, tx) => {
    // Embedded gifts (donationAmount on an outflow row) count toward the
    // donation too, at the row's implied rate |movement + cost| / |amount|.
    if (tx.donationAmount != null && tx.amount)
      return sum + (Math.abs(tx.movement + tx.cost) * Number(tx.donationAmount)) / Math.abs(Number(tx.amount))
    return ['donation', 'tontine'].includes(getFimsTransactionType(tx)) ? sum + (tx.movement ?? 0) : sum
  }, 0)
  return Math.max(0, pnl * tontineRate - donated)
}

// Tontine carve on an outgoing operation: while the member still owes the
// tontine, tontineRate of the sent units is diverted to the pot — deducted
// from the transfer, never added on top. Two bounds apply:
// - capped at the remaining debt converted to units at the token's EUR price
//   (a 10 EUR debt on a 3000 EUR send collects only 10 EUR);
// - exit rule: the member can withdraw at most position − debt, so a send
//   beyond that pays the excess to the pot — cashing out the last available
//   euros settles the full debt and delivers nothing.
// An unpriced token cannot apply either bound and stays at the rate share.
export function computeFimsTontineCarve({
  amount,
  debt,
  decimals,
  positionEur,
  priceEur,
  tontineRate,
}: {
  amount: bigint
  debt: null | number
  decimals: number
  positionEur?: null | number | undefined
  priceEur?: null | number | undefined
  tontineRate: number
}): bigint {
  if (amount <= 0n || debt == null || debt <= 0) return 0n
  let carve = BigInt(Math.floor(Number(amount) * tontineRate))
  if (positionEur != null && priceEur != null && priceEur > 0) {
    const freeUnits = (Math.max(0, positionEur - debt) / priceEur) * 10 ** decimals
    const exitShare = BigInt(Math.max(0, Math.floor(Number(amount) - freeUnits)))
    if (exitShare > carve) carve = exitShare
  }
  if (priceEur != null && priceEur > 0) {
    const cap = BigInt(Math.floor((debt / priceEur) * 10 ** decimals))
    if (cap < carve) carve = cap
  }
  return carve > amount ? amount : carve
}

// Full split of a plain send: the tontine carve (when debt remains) plus the
// operating fee, both deducted from the entered amount and taken in kind on
// the sent mint — the destination receives what remains.
export function computeFimsSendSplit({
  amount,
  debt,
  decimals,
  feeRate,
  positionEur,
  priceEur,
  tontineRate,
}: {
  amount: bigint
  debt: null | number
  decimals: number
  feeRate: number
  positionEur?: null | number | undefined
  priceEur?: null | number | undefined
  tontineRate: number
}): { destination: bigint; fee: bigint; tontine: bigint } {
  const tontine = computeFimsTontineCarve({ amount, debt, decimals, positionEur, priceEur, tontineRate })
  const feeable = amount - tontine
  const fee = BigInt(Math.floor(Number(feeable) * feeRate))
  return { destination: feeable - fee, fee, tontine }
}
