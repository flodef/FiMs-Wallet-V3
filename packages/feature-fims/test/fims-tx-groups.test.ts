import { describe, expect, it } from 'vitest'
import type { FimsTransaction } from '../src/fims-api.ts'
import { groupFimsTransactions } from '../src/fims-tx-groups.ts'

function tx(id: number, opts: Partial<FimsTransaction> = {}): FimsTransaction {
  return {
    address: 'x',
    amount: null,
    cost: 0,
    createdAt: '',
    date: '2026-01-01',
    donationAmount: null,
    donationTarget: null,
    id,
    movement: 0,
    signature: null,
    token: null,
    type: null,
    userId: 1,
    ...opts,
  }
}

describe('group-fims-transactions', () => {
  describe('expected behavior', () => {
    it('should pair a conversion by requestId with the credit leg second', () => {
      // ARRANGE — debit -30 FSOL (requestId R) + credit +2994 FiMs (R:credit).
      expect.assertions(3)
      const rows = [
        tx(2, { amount: '2994', movement: 2994, requestId: 'R:credit', token: 'FiMs', type: 'conversion' }),
        tx(1, { amount: '-30', movement: -3000, requestId: 'R', token: 'FSOL', type: 'conversion' }),
      ]

      // ACT
      const result = groupFimsTransactions(rows)

      // ASSERT — one group, debit leg first.
      expect(result).toHaveLength(1)
      expect(result[0]?.legs.map((l) => l.id)).toEqual([1, 2])
      expect(result[0]?.legs[0]?.movement).toBeLessThan(0)
    })

    it('should pair legacy conversions on opposite movements at the same date', () => {
      // ARRANGE — imported rows without requestId: -3000 then +2994.
      expect.assertions(2)
      const rows = [
        tx(1, { amount: '-3000', movement: -3000, token: 'FSOL', type: 'conversion' }),
        tx(2, { amount: '2994', movement: 2994, token: 'FiMs', type: 'conversion' }),
      ]

      // ACT
      const result = groupFimsTransactions(rows)

      // ASSERT
      expect(result).toHaveLength(1)
      expect(result[0]?.legs.map((l) => l.id)).toEqual([1, 2])
    })

    it('should keep non-conversion rows and unmatched conversions as singles', () => {
      // ARRANGE — a deposit plus a lone conversion credit.
      expect.assertions(3)
      const rows = [
        tx(1, { amount: '100', movement: 100, token: 'FiMs', type: 'deposit' }),
        tx(2, { amount: '50', movement: 50, token: 'FSOL', type: 'conversion' }),
      ]

      // ACT
      const result = groupFimsTransactions(rows)

      // ASSERT
      expect(result).toHaveLength(2)
      expect(result[0]?.legs).toHaveLength(1)
      expect(result[1]?.legs).toHaveLength(1)
    })

    it('should not pair conversions whose dates differ', () => {
      // ARRANGE — same magnitudes but different timestamps.
      expect.assertions(1)
      const rows = [
        tx(1, { amount: '-3000', date: '2026-01-01', movement: -3000, type: 'conversion' }),
        tx(2, { amount: '3000', date: '2026-01-02', movement: 3000, type: 'conversion' }),
      ]

      // ACT
      const result = groupFimsTransactions(rows)

      // ASSERT
      expect(result).toHaveLength(2)
    })
  })
})
