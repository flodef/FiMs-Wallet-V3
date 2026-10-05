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
