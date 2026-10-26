import type { ChainTransaction } from '@workspace/feature-portfolio/data-access/chain-api'
import {
  aggregateFimsLedgerFlows,
  aggregateTokenFlows,
  type FimsLedgerRow,
  type TokenFlow,
} from '@workspace/feature-portfolio/data-access/chain-pnl'
import { NATIVE_MINT } from '@workspace/solana-client/constants'

// ─── Realized-gain tontine ─────────────────────────────────────────────────
// A member owes `tontineRate` of the gain REALIZED by each outgoing operation
// — swaps, partial sales, and plain sends to another address all count (a
// send is priced at the current market value, so routing tokens out through
// a second wallet cannot dodge the share). There is no standing debt and no
// exit rule: a sale at or under cost carves 0, and the share is computed
// only on the units actually leaving, at the moment of the operation.
//
// Cost basis (PRU) per mint:
// - protocol tokens (FiMs, FSOL, FLiP…) get the EXACT basis from the FiMs
//   ledger — mint/redeem/conversion rows record the EUR paid;
// - every other mint keeps whatever the on-chain swap legs priced against
//   stablecoins — the best reconstruction available;
// - a mint whose buys were never priced (received by transfer, or history
//   still backfilling) reports `null` and the carve treats its basis as 0:
//   the whole outgoing value counts as gain, so the rule cannot be dodged
//   by hiding cost.

// 'SOL' is the chain-flow key for native SOL — ledger rows may join by the
// wrapped mint (So111…), so both fold under one lookup key.
export const fimsBasisKey = (mint: null | string): string => (mint == null || mint === NATIVE_MINT ? 'SOL' : mint)

export interface FimsCostBasisInput {
  chainTxs: ChainTransaction[]
  ledgerRows: FimsLedgerRow[]
  // symbol → mint for protocol tokens (joins ledger rows to chain flows).
  mintBySymbol: ReadonlyMap<string, string>
  usdPerEur: number
}

// Per-mint average buy price in EUR per unit; `null` when no priced inflow
// exists. Ledger-covered mints own their key outright (ledger EUR values are
// exact — a chain swap leg on the same mint is a different economic event),
// the chain fills every other mint it priced.
export function computeFimsCostBasisEur({
  chainTxs,
  ledgerRows,
  mintBySymbol,
  usdPerEur,
}: FimsCostBasisInput): Map<string, null | number> {
  const basis = new Map<string, null | number>()
  const put = (flow: TokenFlow) => {
    const eur = flow.boughtQty > 0 && usdPerEur > 0 ? flow.boughtUsd / flow.boughtQty / usdPerEur : null
    basis.set(fimsBasisKey(flow.mint), eur)
  }
  const ledgerFlows = aggregateFimsLedgerFlows(ledgerRows, mintBySymbol, usdPerEur)
  const covered = new Set(ledgerFlows.map((flow) => fimsBasisKey(flow.mint)))
  for (const flow of ledgerFlows) put(flow)
  for (const flow of aggregateTokenFlows(chainTxs)) {
    if (!covered.has(fimsBasisKey(flow.mint))) put(flow)
  }
  return basis
}

// Big-int scaling for rate × share math — keeps sub-unit precision without
// dropping bigint accuracy the way Number(amount) would on large mints.
const SHARE_SCALE = 1_000_000_000n
const scaledShare = (rate: number) => BigInt(Math.floor(rate * Number(SHARE_SCALE)))

// Tontine carve on an outgoing operation: `tontineRate` of the realized gain
// only, taken in kind on the sent mint — deducted from the amount, never on
// top. gain = units × (priceEur − basis); expressed in sent units it is
// amount × rate × (price − basis) / price. basis null → 0 (see header);
// an unpriced token's gain is unknowable → carve 0.
export function computeFimsRealizedCarve({
  amount,
  avgBuyEur,
  priceEur,
  tontineRate,
}: {
  amount: bigint
  avgBuyEur?: null | number | undefined
  priceEur?: null | number | undefined
  tontineRate: number
}): bigint {
  if (amount <= 0n || priceEur == null || !(priceEur > 0)) return 0n
  const gainShare = Math.max(0, (priceEur - (avgBuyEur ?? 0)) / priceEur)
  const carve = (amount * scaledShare(tontineRate * gainShare)) / SHARE_SCALE
  return carve > amount ? amount : carve
}

// Full split of a plain send: the realized-gain carve plus the operating
// fee, both deducted from the entered amount and taken in kind on the sent
// mint — the destination receives what remains.
export function computeFimsSendSplit({
  amount,
  avgBuyEur,
  feeRate,
  priceEur,
  tontineRate,
}: {
  amount: bigint
  avgBuyEur?: null | number | undefined
  feeRate: number
  priceEur?: null | number | undefined
  tontineRate: number
}): { destination: bigint; fee: bigint; tontine: bigint } {
  const tontine = computeFimsRealizedCarve({ amount, avgBuyEur, priceEur, tontineRate })
  const feeable = amount - tontine
  const fee = (feeable * scaledShare(feeRate)) / SHARE_SCALE
  return { destination: feeable - fee, fee, tontine }
}
