import type { FimsToken, FimsTransaction } from './fims-api.ts'

export interface FimsPosition {
  avgBuyPrice: null | number
  currentValue: null | number
  invested: number
  pnl: number
  pnlRatio: null | number
  returned: number
  symbol: string
  units: number
}

// Sign convention: amount/movement > 0 = buy (EUR in), < 0 = sell (EUR out).
export function computeFimsPositions(transactions: FimsTransaction[], tokens: FimsToken[]): FimsPosition[] {
  const priceBySymbol = new Map(tokens.map((t) => [t.symbol, t.value]))
  const bySymbol = new Map<string, { invested: number; returned: number; unitsBought: number; unitsSold: number }>()

  for (const tx of transactions) {
    if (!tx.token || tx.amount == null) continue
    const bucket = bySymbol.get(tx.token) ?? { invested: 0, returned: 0, unitsBought: 0, unitsSold: 0 }
    if (tx.amount >= 0) {
      bucket.unitsBought += tx.amount
      bucket.invested += Math.max(tx.movement, 0)
    } else {
      // An embedded gift (donationAmount on an outflow row) is an extra
      // outflow on top of `amount`: the gifted units keep counting as
      // invested — the member's tontine stake is still a position — priced
      // at the row's implied rate |movement + cost| / |amount|.
      const gifted = Math.max(tx.donationAmount ?? 0, 0)
      bucket.unitsBought += gifted
      bucket.invested += (Math.abs(tx.movement + tx.cost) * gifted) / -tx.amount
      bucket.unitsSold -= tx.amount
      bucket.returned += Math.max(-tx.movement, 0)
    }
    bySymbol.set(tx.token, bucket)
  }

  return [...bySymbol.entries()]
    .map(([symbol, b]) => {
      const units = b.unitsBought - b.unitsSold
      const avgBuyPrice = b.unitsBought > 0 ? b.invested / b.unitsBought : null
      const price = priceBySymbol.get(symbol)
      const currentValue = units > 0 && price != null ? units * price : null
      const pnl = b.returned + (currentValue ?? 0) - b.invested
      return {
        avgBuyPrice,
        currentValue,
        invested: b.invested,
        pnl,
        pnlRatio: b.invested > 0 ? pnl / b.invested : null,
        returned: b.returned,
        symbol,
        units,
      }
    })
    .filter((p) => p.units > 0 || p.returned > 0)
    .sort((a, b) => (b.currentValue ?? 0) - (a.currentValue ?? 0))
}
