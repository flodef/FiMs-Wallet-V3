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

const DAY_MS = 24 * 60 * 60 * 1000

// Annualized growth rate actually achieved between two dated values — the
// realized rate (backward-looking), as opposed to a projected current rate.
// `undefined` when the span is too short to be meaningful (< `minDays`).
export function annualizedRate(
  from: { date: string; value: number },
  to: { date: string; value: number },
): number | undefined {
  const days = (Date.parse(to.date) - Date.parse(from.date)) / DAY_MS
  if (days < 1 || from.value <= 0 || to.value <= 0) {
    return undefined
  }
  return (to.value / from.value) ** (365.25 / days) - 1
}

// Map symbol → annualized rate actually realized over the full available
// history (first → last price point). Windows shorter than `minDays` are
// skipped: annualized over a few days, noise exaggerates the figure.
export function computeRealizedAnnualRates(points: PricePoint[], minDays = 30): Map<string, number> {
  const byToken = new Map<string, { first?: { date: string; price: number }; last?: { date: string; price: number } }>()
  for (const point of points) {
    if (!Number.isFinite(point.price) || point.price <= 0) {
      continue
    }
    const entry = byToken.get(point.token) ?? {}
    if (!entry.first || point.date < entry.first.date) {
      entry.first = point
    }
    if (!entry.last || point.date > entry.last.date) {
      entry.last = point
    }
    byToken.set(point.token, entry)
  }
  const result = new Map<string, number>()
  for (const [token, { first, last }] of byToken) {
    if (!first || !last || first === last) {
      continue
    }
    const days = (Date.parse(last.date) - Date.parse(first.date)) / DAY_MS
    if (days < minDays) {
      continue
    }
    const rate = annualizedRate({ date: first.date, value: first.price }, { date: last.date, value: last.price })
    if (rate !== undefined && Number.isFinite(rate)) {
      result.set(token, rate)
    }
  }
  return result
}
