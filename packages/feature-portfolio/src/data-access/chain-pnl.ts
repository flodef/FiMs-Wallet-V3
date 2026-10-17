import type { ChainTransaction } from './chain-api.ts'

// Per-token profit & loss from normalized on-chain history.
//
// USD attribution rule: only swap legs priced against a stablecoin are valued
// — the USD value of a buy is what was paid in USDC/USDT/EURC, the value of a
// sell is what was received. Plain transfers (CEX moves, gifts, payments) move
// quantity without a knowable fiat price, so they only update qtyIn/qtyOut.
// EURC counts at the 1 EUR = 1.125 USD convention used for reporting.

const STABLE_USD_PER_UNIT: Record<string, number> = {
  // USDC / USDT
  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: 1,
  Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: 1,
  // EURC
  HzwqbKZw8HxMN6bF2yFZNrht3c2iXXcyKpuPu7vVYrt: 1.125,
}

export function stableUsdValue(mint: null | string, amount: number): number {
  if (!mint) return 0
  return amount * (STABLE_USD_PER_UNIT[mint] ?? 0)
}

export interface TokenFlow {
  // Quantity of in-legs whose USD cost is known (swap buys).
  boughtQty: number
  boughtUsd: number
  mint: null | string
  // Quantity moved in/out including unpriced transfers.
  qtyIn: number
  qtyOut: number
  // Quantity of out-legs whose USD proceeds are known (swap sells).
  soldQty: number
  soldUsd: number
  symbol: string
}

const flowKey = (mint: null | string) => mint ?? 'SOL'

// One aggregated flow line per token. Swap USD legs are attributed to a token
// only when it is the single non-stable leg on its side (the common case —
// multi-hop swaps leave the value unpriced rather than misattributed).
export function aggregateTokenFlows(txs: ChainTransaction[]): TokenFlow[] {
  const byMint = new Map<string, TokenFlow>()
  const flow = (mint: null | string, symbol: null | string): TokenFlow => {
    const key = flowKey(mint)
    const existing = byMint.get(key)
    if (existing) return existing
    const created: TokenFlow = {
      boughtQty: 0,
      boughtUsd: 0,
      mint,
      qtyIn: 0,
      qtyOut: 0,
      soldQty: 0,
      soldUsd: 0,
      symbol: symbol ?? (mint ? `${mint.slice(0, 4)}…` : 'SOL'),
    }
    byMint.set(key, created)
    return created
  }

  for (const tx of txs) {
    const ins = tx.transfers.filter((t) => t.direction === 'in')
    const outs = tx.transfers.filter((t) => t.direction === 'out')
    const stableInUsd = ins.reduce((sum, t) => sum + stableUsdValue(t.mint, t.amount), 0)
    const stableOutUsd = outs.reduce((sum, t) => sum + stableUsdValue(t.mint, t.amount), 0)
    const nonStableIns = ins.filter((t) => !stableUsdValue(t.mint, 1))
    const nonStableOuts = outs.filter((t) => !stableUsdValue(t.mint, 1))

    const isSwap = tx.type === 'SWAP'
    for (const t of ins) {
      const f = flow(t.mint, t.symbol)
      f.qtyIn += t.amount
      if (isSwap && stableOutUsd > 0 && nonStableIns.length === 1 && t === nonStableIns[0]) {
        f.boughtQty += t.amount
        f.boughtUsd += stableOutUsd
      }
    }
    for (const t of outs) {
      const f = flow(t.mint, t.symbol)
      f.qtyOut += t.amount
      if (isSwap && stableInUsd > 0 && nonStableOuts.length === 1 && t === nonStableOuts[0]) {
        f.soldQty += t.amount
        f.soldUsd += stableInUsd
      }
    }
  }
  return [...byMint.values()].filter((f) => f.qtyIn > 0 || f.qtyOut > 0)
}

export interface TokenPnl extends TokenFlow {
  // null when no priced buy legs — the average cost is unknowable.
  avgBuyUsd: null | number
  // true when every priced sell is covered by priced buys (otherwise part of
  // the sold quantity predates the synced history).
  basisComplete: boolean
  netQty: number
  realizedUsd: null | number
  unrealizedUsd: null | number
  usdPrice: null | number
}

export function computeTokenPnl(flows: TokenFlow[], usdPrices: Map<string, number>): TokenPnl[] {
  return flows.map((f) => {
    const avgBuyUsd = f.boughtQty > 0 ? f.boughtUsd / f.boughtQty : null
    const basisComplete = f.soldQty <= f.boughtQty + 1e-9
    const realizedUsd =
      avgBuyUsd === null || f.soldQty <= 0 ? null : f.soldUsd - avgBuyUsd * Math.min(f.soldQty, f.boughtQty)
    const netQty = f.qtyIn - f.qtyOut
    const usdPrice = usdPrices.get(flowKey(f.mint)) ?? null
    // Remaining basis = boughtUsd not yet consumed by realized sells.
    const basisHeld = avgBuyUsd === null ? null : avgBuyUsd * Math.max(0, f.boughtQty - f.soldQty)
    const unrealizedUsd = usdPrice === null || netQty <= 0 ? null : netQty * usdPrice - (basisHeld ?? 0)
    return { ...f, avgBuyUsd, basisComplete, netQty, realizedUsd, unrealizedUsd, usdPrice }
  })
}

// ─── Protocol-ledger flows (FiMs, FLiP, FiMsSOL) ────────────────────────────
// Mint/redeem and conversions are plain transfers on-chain — no stable leg,
// no price — so the on-chain analysis above can never build their cost basis.
// The FiMs ledger records the exact EUR value of every member operation:
// `amount` = signed token units, `movement` = signed EUR value. Gifts
// (donation/payment/tontine) move units without proceeds — they only count
// toward quantity, like unpriced transfers do on-chain.

export interface FimsLedgerRow {
  amount: null | string
  movement: number
  token: null | string
  type: null | string
}

const LEDGER_GIFT_TYPES = new Set(['donation', 'payment', 'tontine'])

// Rows are per (token, user): deposit/withdrawal/conversion/cex are capital
// flows priced at |movement| EUR — converted to USD here so they merge into
// the chain-side TokenFlow shape.
export function aggregateFimsLedgerFlows(
  rows: FimsLedgerRow[],
  mintBySymbol: ReadonlyMap<string, string>,
  usdPerEur: number,
): TokenFlow[] {
  const byMint = new Map<string, TokenFlow>()
  for (const row of rows) {
    if (!row.token || row.amount === null) continue
    const mint = mintBySymbol.get(row.token)
    if (!mint) continue
    const amount = Number(row.amount)
    if (!Number.isFinite(amount) || amount === 0) continue
    let flow = byMint.get(mint)
    if (!flow) {
      flow = {
        boughtQty: 0,
        boughtUsd: 0,
        mint,
        qtyIn: 0,
        qtyOut: 0,
        soldQty: 0,
        soldUsd: 0,
        symbol: row.token,
      }
      byMint.set(mint, flow)
    }
    const eur = Math.abs(row.movement)
    const usd = eur * usdPerEur
    if (amount > 0) {
      flow.qtyIn += amount
      if (!LEDGER_GIFT_TYPES.has(row.type ?? '')) {
        flow.boughtQty += amount
        flow.boughtUsd += usd
      }
    } else {
      const out = Math.abs(amount)
      flow.qtyOut += out
      if (!LEDGER_GIFT_TYPES.has(row.type ?? '')) {
        flow.soldQty += out
        flow.soldUsd += usd
      }
    }
  }
  return [...byMint.values()]
}

// Overlay ledger flows onto chain flows for the same mint. When the ledger
// covers a mint it OWNS the priced fields — its EUR values are exact, while
// the chain-side swap attribution would double-count the same economic
// event. The chain keeps qtyIn/qtyOut for on-chain moves the ledger never
// saw (direct transfers between members, gifts).
// The ledger fully owns priced fields for the mints it covers — right while
// FiMs-family tokens have no DEX-priced legs. If one ever lists on a DEX, the
// chain-side cost basis for that mint would be silently dropped here.
export function mergeLedgerFlows(chain: TokenFlow[], ledger: TokenFlow[]): TokenFlow[] {
  const merged = new Map<string, TokenFlow>(chain.map((f) => [flowKey(f.mint), { ...f }]))
  for (const lf of ledger) {
    const key = flowKey(lf.mint)
    const existing = merged.get(key)
    if (!existing) {
      merged.set(key, lf)
      continue
    }
    existing.boughtQty = lf.boughtQty
    existing.boughtUsd = lf.boughtUsd
    existing.soldQty = lf.soldQty
    existing.soldUsd = lf.soldUsd
  }
  return [...merged.values()]
}
