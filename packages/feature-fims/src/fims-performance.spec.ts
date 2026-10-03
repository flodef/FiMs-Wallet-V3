import { describe, expect, it } from 'vitest'

import { computePeriodReturns } from './fims-performance.ts'

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
