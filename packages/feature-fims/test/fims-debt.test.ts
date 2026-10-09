import { describe, expect, it } from 'vitest'
import type { FimsTransaction } from '../src/fims-api.ts'
import { computeFimsDebt, computeFimsSendSplit, computeFimsTontineCarve } from '../src/fims-debt.ts'

function tx(movement: number, opts: Partial<FimsTransaction> = {}): FimsTransaction {
  return {
    address: 'x',
    amount: null,
    cost: 0,
    createdAt: '',
    date: '',
    donationAmount: null,
    donationTarget: null,
    id: 0,
    movement,
    signature: null,
    token: null,
    type: null,
    userId: 1,
    ...opts,
  }
}

const RATE = 0.1

describe('compute-fims-debt', () => {
  describe('expected behavior', () => {
    it('should owe the tontine rate on gains including realized withdrawals', () => {
      // ARRANGE — member deposited 100000, withdrew 20000, holds 120000:
      // net contributed 80000, gains 40000 (withdrawn profit counts).
      expect.assertions(1)
      const transactions = [tx(100000), tx(-20000)]

      // ACT
      const result = computeFimsDebt(120000, transactions, RATE)

      // ASSERT
      expect(result).toBeCloseTo(4000)
    })

    it('should subtract donations already given from the debt', () => {
      // ARRANGE — same member also gave 5000 to the tontine.
      expect.assertions(1)
      const transactions = [tx(100000), tx(-20000), tx(5000, { cost: 5000, type: 'donation' })]

      // ACT
      const result = computeFimsDebt(120000, transactions, RATE)

      // ASSERT — 10% × 40000 − 5000 < 0 → nothing owed.
      expect(result).toBe(0)
    })

    it('should exclude donation and payment rows from the contributed basis', () => {
      // ARRANGE — a payment (-100, cost=-100) is a gift outflow, not capital:
      // the basis must stay 80000 either way.
      expect.assertions(1)
      const transactions = [tx(100000), tx(-20000), tx(-100, { cost: -100, type: 'payment' })]

      // ACT
      const result = computeFimsDebt(120000, transactions, RATE)

      // ASSERT
      expect(result).toBeCloseTo(4000)
    })

    it('should count an embedded donation at the row implied rate', () => {
      // ARRANGE — withdrawal of 30 units for 2994 net (6 fee) carrying 3
      // gifted units: implied rate 3000/30 → donated 300.
      expect.assertions(1)
      const transactions = [
        tx(100000),
        tx(-2994, {
          amount: '-30',
          cost: -6,
          donationAmount: '3',
          donationTarget: 'tontine',
          type: 'withdrawal',
        }),
      ]

      // ACT
      const result = computeFimsDebt(120000, transactions, RATE)

      // ASSERT — net 97006, gains 22994, 10% − 300 = 1999.4.
      expect(result).toBeCloseTo(1999.4)
    })

    it('should return zero when the member is at a loss', () => {
      // ARRANGE — total value below net contributed.
      expect.assertions(1)
      const transactions = [tx(100000), tx(-5000)]

      // ACT
      const result = computeFimsDebt(90000, transactions, RATE)

      // ASSERT
      expect(result).toBe(0)
    })
  })
})

describe('compute-fims-tontine-carve', () => {
  describe('expected behavior', () => {
    it('should carve the tontine rate out of the sent amount', () => {
      // ARRANGE — 844 units at 6 decimals, member still owes the tontine.
      expect.assertions(1)

      // ACT
      const result = computeFimsTontineCarve({
        amount: 844_000_000n,
        debt: 500,
        decimals: 6,
        priceEur: 1.19,
        tontineRate: RATE,
      })

      // ASSERT — 10% of the send → 84.4 units.
      expect(result).toBe(84_400_000n)
    })

    it('should cap the carve at the remaining debt converted to units', () => {
      // ARRANGE — 10% of the send (100 units ≈ 119 EUR) exceeds the 50 EUR
      // still owed → only ~42 units are carved.
      expect.assertions(1)

      // ACT
      const result = computeFimsTontineCarve({
        amount: 1_000_000_000n,
        debt: 50,
        decimals: 6,
        priceEur: 1.19,
        tontineRate: RATE,
      })

      // ASSERT — floor(50 / 1.19 × 10^6).
      expect(result).toBe(42_016_806n)
    })

    it('should carve nothing when the debt is settled or unknown', () => {
      // ARRANGE
      expect.assertions(3)

      // ACT & ASSERT
      expect(
        computeFimsTontineCarve({ amount: 1_000_000_000n, debt: 0, decimals: 6, priceEur: 1, tontineRate: RATE }),
      ).toBe(0n)
      expect(
        computeFimsTontineCarve({ amount: 1_000_000_000n, debt: null, decimals: 6, priceEur: 1, tontineRate: RATE }),
      ).toBe(0n)
      expect(
        computeFimsTontineCarve({ amount: 1_000_000_000n, debt: -10, decimals: 6, priceEur: 1, tontineRate: RATE }),
      ).toBe(0n)
    })

    it('should keep the raw rate share when the token is unpriced', () => {
      // ARRANGE — debt owed but no EUR price for the token → no unit cap.
      expect.assertions(1)

      // ACT
      const result = computeFimsTontineCarve({
        amount: 1_000_000_000n,
        debt: 1,
        decimals: 6,
        tontineRate: RATE,
      })

      // ASSERT
      expect(result).toBe(100_000_000n)
    })

    it('should settle the debt when the send exceeds position minus debt', () => {
      // ARRANGE — debt 300 on a 600 EUR position; sending 500 (units at 1 EUR)
      // withdraws past the 300 EUR the member may keep → carve 200.
      expect.assertions(1)

      // ACT
      const result = computeFimsTontineCarve({
        amount: 500_000_000n,
        debt: 300,
        decimals: 6,
        positionEur: 600,
        priceEur: 1,
        tontineRate: RATE,
      })

      // ASSERT — max(10% × 500, 500 − (600 − 300)) = 200.
      expect(result).toBe(200_000_000n)
    })

    it('should let the member keep nothing when sending the last available euros', () => {
      // ARRANGE — after the 500 send above: position 100, debt 100. Sending
      // the last 100 pays the whole debt and delivers zero.
      expect.assertions(1)

      // ACT
      const result = computeFimsTontineCarve({
        amount: 100_000_000n,
        debt: 100,
        decimals: 6,
        positionEur: 100,
        priceEur: 1,
        tontineRate: RATE,
      })

      // ASSERT — carve = min(debt 100, amount 100) = everything.
      expect(result).toBe(100_000_000n)
    })

    it('should ignore the exit rule when the position is unknown', () => {
      // ARRANGE — no position data → plain rate share.
      expect.assertions(1)

      // ACT
      const result = computeFimsTontineCarve({
        amount: 500_000_000n,
        debt: 300,
        decimals: 6,
        priceEur: 1,
        tontineRate: RATE,
      })

      // ASSERT
      expect(result).toBe(50_000_000n)
    })
  })
})

describe('compute-fims-send-split', () => {
  describe('expected behavior', () => {
    it('should split a send into destination, operating fee and tontine share', () => {
      // ARRANGE — 1000 units, debt open, 0.2% fee, 10% tontine.
      expect.assertions(3)

      // ACT
      const result = computeFimsSendSplit({
        amount: 1_000_000_000n,
        debt: 10_000,
        decimals: 6,
        feeRate: 0.002,
        positionEur: 1_000_000,
        priceEur: 1,
        tontineRate: RATE,
      })

      // ASSERT — 100 to the pot, 1.8 fee on the remaining 900, dest 898.2.
      expect(result.tontine).toBe(100_000_000n)
      expect(result.fee).toBe(1_800_000n)
      expect(result.destination).toBe(898_200_000n)
    })

    it('should charge only the fee when no debt remains', () => {
      // ARRANGE
      expect.assertions(3)

      // ACT
      const result = computeFimsSendSplit({
        amount: 1_000_000_000n,
        debt: 0,
        decimals: 6,
        feeRate: 0.002,
        priceEur: 1,
        tontineRate: RATE,
      })

      // ASSERT
      expect(result.tontine).toBe(0n)
      expect(result.fee).toBe(2_000_000n)
      expect(result.destination).toBe(998_000_000n)
    })
  })
})
