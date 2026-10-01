import type { FimsPosition } from './fims-positions.ts'

// Fiat-pegged symbols form the "safe" bucket; every other position is risky.
const SAFE_SYMBOLS = new Set(['EUR', 'EURC', 'PYUSD', 'USDC', 'USDG', 'USDS', 'USDT'])

export const isSafeSymbol = (symbol: string) => SAFE_SYMBOLS.has(symbol.toUpperCase())

export interface RebalancePlan {
  currentRiskyRatio: number
  driftRatio: number
  driftValue: number
  fromSymbol: null | string
  needsRebalance: boolean
  riskyValue: number
  safeValue: number
  toSymbol: null | string
  totalValue: number
}

// Minimal EUR drift before a rebalance is worth proposing.
const MIN_DRIFT_VALUE = 5
const MIN_DRIFT_RATIO = 0.02

/**
 * Member-level drift check: compares the current risky/safe split against the
 * member's target (`targetRatio` = share of risky assets, 0..1) and proposes
 * the corrective conversion (sell the largest position of the overweight side).
 */
export function computeRebalancePlan(
  positions: FimsPosition[],
  targetRatio: number,
  preferredSafe = 'USDC',
): RebalancePlan | null {
  const safeValue = positions.reduce((sum, p) => sum + (isSafeSymbol(p.symbol) ? (p.currentValue ?? 0) : 0), 0)
  const riskyValue = positions.reduce((sum, p) => sum + (isSafeSymbol(p.symbol) ? 0 : (p.currentValue ?? 0)), 0)
  const totalValue = safeValue + riskyValue
  if (totalValue <= 0) return null

  const currentRiskyRatio = riskyValue / totalValue
  const driftRatio = currentRiskyRatio - targetRatio
  const driftValue = Math.abs(driftRatio) * totalValue
  const overRisky = driftRatio > 0

  const largest = (safe: boolean) =>
    positions
      .filter((p) => p.currentValue != null && p.currentValue > 0 && isSafeSymbol(p.symbol) === safe)
      .sort((a, b) => (b.currentValue ?? 0) - (a.currentValue ?? 0))[0]?.symbol ?? null

  const fromSymbol = largest(!overRisky)
  const toSymbol = overRisky ? (largest(true) ?? preferredSafe) : (largest(false) ?? null)

  return {
    currentRiskyRatio,
    driftRatio,
    driftValue,
    fromSymbol,
    needsRebalance:
      driftValue > MIN_DRIFT_VALUE && Math.abs(driftRatio) > MIN_DRIFT_RATIO && fromSymbol != null && toSymbol != null,
    riskyValue,
    safeValue,
    toSymbol,
    totalValue,
  }
}
