export interface PricePoint {
  date: string
  price: number
  token: string
}

// Map symbol → return ratio over the trailing `days` window
// (e.g. 0.12 = +12%). Symbols without enough history are absent.
export function computePeriodReturns(points: PricePoint[], days = 30): Map<string, number> {
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000
  const byToken = new Map<string, { date: string; price: number }[]>()
  for (const point of points) {
    if (!Number.isFinite(point.price) || point.price <= 0) {
      continue
    }
    const list = byToken.get(point.token) ?? []
    list.push({ date: point.date, price: point.price })
    byToken.set(point.token, list)
  }
  const result = new Map<string, number>()
  for (const [token, list] of byToken) {
    const sorted = [...list].sort((a, b) => a.date.localeCompare(b.date))
    const latest = sorted.at(-1)
    const reference = sorted.findLast((point) => Date.parse(point.date) <= cutoff)
    if (!latest || !reference || reference === latest) {
      continue
    }
    result.set(token, latest.price / reference.price - 1)
  }
  return result
}
