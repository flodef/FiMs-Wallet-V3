import { describe, expect, it } from 'vitest'
import type { FimsPosition } from '../src/fims-positions.ts'
import { computeRebalancePlan, isSafeSymbol } from '../src/fims-risk.ts'

function pos(symbol: string, currentValue: number | null): FimsPosition {
  return {
    avgBuyPrice: null,
    currentValue,
    invested: 0,
    pnl: 0,
    pnlRatio: null,
    returned: 0,
    symbol,
    units: 1,
  }
}

describe('is-safe-symbol', () => {
  it('should classify fiat-pegged symbols as safe', () => {
    // ARRANGE
    expect.assertions(3)

    // ACT & ASSERT
    expect(isSafeSymbol('USDC')).toBe(true)
    expect(isSafeSymbol('eurc')).toBe(true)
    expect(isSafeSymbol('FSOL')).toBe(false)
  })
})

describe('compute-rebalance-plan', () => {
  describe('expected behavior', () => {
    it('should propose selling the largest risky position when over the target', () => {
      // ARRANGE
      expect.assertions(5)
      const positions = [pos('FSOL', 600), pos('ZEC', 200), pos('USDC', 200)]

      // ACT
      const result = computeRebalancePlan(positions, 0.5)

      // ASSERT
      expect(result).not.toBeNull()
      expect(result?.driftValue).toBeCloseTo(300)
      expect(result?.fromSymbol).toBe('FSOL')
      expect(result?.toSymbol).toBe('USDC')
      expect(result?.needsRebalance).toBe(true)
    })

    it('should propose buying risky when under the target', () => {
      // ARRANGE
      expect.assertions(3)
      const positions = [pos('USDC', 900), pos('FSOL', 100)]

      // ACT
      const result = computeRebalancePlan(positions, 0.5)

      // ASSERT
      expect(result?.fromSymbol).toBe('USDC')
      expect(result?.toSymbol).toBe('FSOL')
      expect(result?.needsRebalance).toBe(true)
    })

    it('should stay quiet when inside the drift bounds', () => {
      // ARRANGE
      expect.assertions(2)
      const positions = [pos('FSOL', 510), pos('USDC', 490)]

      // ACT
      const result = computeRebalancePlan(positions, 0.5)

      // ASSERT
      expect(result).not.toBeNull()
      expect(result?.needsRebalance).toBe(false)
    })

    it('should prefer an already-held stable as the buy target', () => {
      // ARRANGE
      expect.assertions(2)
      const positions = [pos('FSOL', 800), pos('EURC', 200)]

      // ACT
      const result = computeRebalancePlan(positions, 0.5)

      // ASSERT
      expect(result?.fromSymbol).toBe('FSOL')
      expect(result?.toSymbol).toBe('EURC')
    })

    it('should fall back to the preferred stable when none is held', () => {
      // ARRANGE
      expect.assertions(1)
      const positions = [pos('FSOL', 900), pos('ZEC', 100)]

      // ACT
      const result = computeRebalancePlan(positions, 0.5, 'USDC')

      // ASSERT
      expect(result?.toSymbol).toBe('USDC')
    })
  })

  describe('unexpected behavior', () => {
    it('should return null when the portfolio is empty', () => {
      // ARRANGE
      expect.assertions(1)

      // ACT
      const result = computeRebalancePlan([], 0.5)

      // ASSERT
      expect(result).toBeNull()
    })

    it('should not propose a rebalance when the overweight side has no sellable token', () => {
      // ARRANGE
      expect.assertions(2)
      const positions = [pos('FSOL', null), pos('USDC', 100)]

      // ACT
      const result = computeRebalancePlan(positions, 0.9)

      // ASSERT
      expect(result?.fromSymbol).toBe('USDC')
      expect(result?.needsRebalance).toBe(false)
    })
  })
})
