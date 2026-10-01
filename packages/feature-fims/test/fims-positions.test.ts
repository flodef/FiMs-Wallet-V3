// cspell:ignore FSOL
import { describe, expect, it } from 'vitest'
import type { FimsToken, FimsTransaction } from '../src/fims-api.ts'
import { computeFimsPositions } from '../src/fims-positions.ts'

function tx(amount: number, movement: number, token: string): FimsTransaction {
  return {
    address: 'x',
    amount,
    cost: 0,
    createdAt: '',
    date: '',
    donationTarget: null,
    id: 0,
    movement,
    signature: null,
    token,
    type: null,
    userId: 1,
  }
}

function token(symbol: string, value: number): FimsToken {
  return {
    address: null,
    description: null,
    duration: null,
    inceptionPrice: null,
    inceptionRatio: null,
    label: symbol,
    symbol,
    updatedAt: '',
    value,
    volatility: null,
    yearlyYield: null,
  }
}

describe('compute-fims-positions', () => {
  describe('expected behavior', () => {
    it('should compute units, average buy price, value and pnl for a held token', () => {
      // ARRANGE
      expect.assertions(5)
      const transactions = [tx(10, 100, 'FSOL'), tx(10, 140, 'FSOL')]
      const tokens = [token('FSOL', 20)]

      // ACT
      const result = computeFimsPositions(transactions, tokens)

      // ASSERT
      expect(result).toHaveLength(1)
      expect(result[0]?.units).toBe(20)
      expect(result[0]?.avgBuyPrice).toBe(12)
      expect(result[0]?.currentValue).toBe(400)
      expect(result[0]?.pnl).toBe(160)
    })

    it('should keep remaining basis at average price after a partial sell', () => {
      // ARRANGE
      expect.assertions(3)
      const transactions = [tx(10, 100, 'FSOL'), tx(-5, -80, 'FSOL')]
      const tokens = [token('FSOL', 20)]

      // ACT
      const result = computeFimsPositions(transactions, tokens)

      // ASSERT — 5 units held at avg 10, sold for 80: pnl = 80 + 100 - 100 = 80
      expect(result[0]?.units).toBe(5)
      expect(result[0]?.avgBuyPrice).toBe(10)
      expect(result[0]?.pnl).toBe(80)
    })

    it('should report realized pnl for a fully sold token without a current price', () => {
      // ARRANGE
      expect.assertions(3)
      const transactions = [tx(10, 100, 'OLD'), tx(-10, -150, 'OLD')]

      // ACT
      const result = computeFimsPositions(transactions, [])

      // ASSERT
      expect(result[0]?.units).toBe(0)
      expect(result[0]?.currentValue).toBeNull()
      expect(result[0]?.pnl).toBe(50)
    })

    it('should ignore cash flows and transactions without token or amount', () => {
      // ARRANGE
      expect.assertions(2)
      const transactions = [tx(100, 100, ''), { ...tx(0, 0, 'FSOL'), amount: null }, tx(5, 50, 'FSOL')]
      const tokens = [token('FSOL', 10)]

      // ACT
      const result = computeFimsPositions(transactions, tokens)

      // ASSERT
      expect(result).toHaveLength(1)
      expect(result[0]?.units).toBe(5)
    })
  })
})
