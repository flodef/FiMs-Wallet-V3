import { describe, expect, it } from 'vitest'

import { annualizedRate, computePeriodReturns, computeRealizedAnnualRates } from './fims-performance.ts'

const DAY = 24 * 60 * 60 * 1000

function point(token: string, daysAgo: number, price: number) {
  return { date: new Date(Date.now() - daysAgo * DAY).toISOString(), price, token }
}

describe('compute-period-returns', () => {
  describe('expected behavior', () => {
    it('should compute the return between the price 30 days ago and the latest price', async () => {
      // ARRANGE
      expect.assertions(2)
      const points = [point('SOL', 60, 80), point('SOL', 40, 90), point('SOL', 10, 120), point('SOL', 0, 130)]

      // ACT
      const result = computePeriodReturns(points, 30)

      // ASSERT
      expect(result.get('SOL')).toBeCloseTo(130 / 90 - 1, 10)
      expect(result.size).toBe(1)
    })

    it('should omit tokens without a price point older than the window', async () => {
      // ARRANGE
      expect.assertions(1)
      const points = [point('NEW', 10, 5), point('NEW', 0, 6)]

      // ACT
      const result = computePeriodReturns(points, 30)

      // ASSERT
      expect(result.has('NEW')).toBe(false)
    })

    it('should compute returns independently per token', async () => {
      // ARRANGE
      expect.assertions(2)
      const points = [point('AAA', 45, 100), point('AAA', 0, 110), point('BBB', 35, 50), point('BBB', 0, 40)]

      // ACT
      const result = computePeriodReturns(points, 30)

      // ASSERT
      expect(result.get('AAA')).toBeCloseTo(0.1, 10)
      expect(result.get('BBB')).toBeCloseTo(-0.2, 10)
    })
  })
})

describe('annualized-rate', () => {
  describe('expected behavior', () => {
    it('should compute an annualized rate for a positive return over a real holding period', () => {
      // ARRANGE
      expect.assertions(1)
      const from = { date: new Date(Date.now() - 365.25 * DAY).toISOString(), value: 1000 }
      const to = { date: new Date().toISOString(), value: 1100 }

      // ACT
      const result = annualizedRate(from, to)

      // ASSERT
      expect(result).toBeCloseTo(0.1, 2)
    })

    it('should compute an annualized rate over a fraction of a year', () => {
      // ARRANGE
      expect.assertions(1)
      const from = { date: new Date(Date.now() - 180 * DAY).toISOString(), value: 100 }
      const to = { date: new Date().toISOString(), value: 105 }

      // ACT
      const result = annualizedRate(from, to)

      // ASSERT
      // ~5% over half a year ≈ 10.25% annualized (compounded)
      expect(result).toBeCloseTo(0.1025, 2)
    })

    it('should return undefined for a too-short holding period', () => {
      // ARRANGE
      expect.assertions(1)
      const from = { date: new Date(Date.now() - 0.5 * DAY).toISOString(), value: 100 }
      const to = { date: new Date().toISOString(), value: 200 }

      // ACT
      const result = annualizedRate(from, to)

      // ASSERT
      expect(result).toBeUndefined()
    })
  })
})

describe('compute-realized-annual-rates', () => {
  describe('expected behavior', () => {
    it('should compute an annualized rate between the first and the last price point', () => {
      // ARRANGE
      expect.assertions(2)
      const points = [point('SOL', 365.25, 100), point('SOL', 180, 110), point('SOL', 0, 110)]

      // ACT
      const result = computeRealizedAnnualRates(points)

      // ASSERT
      expect(result.get('SOL')).toBeCloseTo(0.1, 2)
      expect(result.size).toBe(1)
    })

    it('should omit tokens whose history is shorter than the minimum window', () => {
      // ARRANGE
      expect.assertions(1)
      const points = [point('NEW', 10, 100), point('NEW', 0, 200)]

      // ACT
      const result = computeRealizedAnnualRates(points)

      // ASSERT
      expect(result.has('NEW')).toBe(false)
    })

    it('should compute a negative annualized rate for a losing token', () => {
      // ARRANGE
      expect.assertions(1)
      const points = [point('BAD', 365.25, 100), point('BAD', 0, 50)]

      // ACT
      const result = computeRealizedAnnualRates(points)

      // ASSERT
      expect(result.get('BAD')).toBeCloseTo(-0.5, 2)
    })
  })
})
