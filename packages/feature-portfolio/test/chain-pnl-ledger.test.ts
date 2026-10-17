import { describe, expect, it } from 'vitest'
import {
  aggregateFimsLedgerFlows,
  type FimsLedgerRow,
  mergeLedgerFlows,
  type TokenFlow,
} from '../src/data-access/chain-pnl.ts'

const mintBySymbol = new Map([
  ['FiMs', 'mint-fims'],
  ['FLiP', 'mint-flip'],
  ['FSOL', 'mint-fsol'],
])

const row = (input: Partial<FimsLedgerRow>): FimsLedgerRow => ({
  amount: '0',
  movement: 0,
  token: 'FiMs',
  type: 'deposit',
  ...input,
})

const flow = (input: Partial<TokenFlow>): TokenFlow => ({
  boughtQty: 0,
  boughtUsd: 0,
  mint: 'mint-fims',
  qtyIn: 0,
  qtyOut: 0,
  soldQty: 0,
  soldUsd: 0,
  symbol: 'FiMs',
  ...input,
})

describe('aggregate-fims-ledger-flows', () => {
  describe('expected behavior', () => {
    it('should price deposits and withdrawals from the ledger EUR movement', () => {
      // ARRANGE
      expect.assertions(4)
      const rows = [
        row({ amount: '10', movement: 100 }),
        row({ amount: '5', movement: 55, type: 'conversion' }),
        row({ amount: '-4', movement: -45, type: 'withdrawal' }),
      ]

      // ACT
      const result = aggregateFimsLedgerFlows(rows, mintBySymbol, 1.2)

      // ASSERT
      expect(result[0]?.boughtQty).toBe(15)
      expect(result[0]?.boughtUsd).toBeCloseTo((100 + 55) * 1.2)
      expect(result[0]?.soldQty).toBe(4)
      expect(result[0]?.soldUsd).toBeCloseTo(45 * 1.2)
    })

    it('should count gifts toward quantity only, never as a priced sell', () => {
      // ARRANGE
      expect.assertions(2)
      const rows = [row({ amount: '-3', movement: -30, type: 'donation' })]

      // ACT
      const result = aggregateFimsLedgerFlows(rows, mintBySymbol, 1.2)

      // ASSERT
      expect(result[0]?.qtyOut).toBe(3)
      expect(result[0]?.soldQty).toBe(0)
    })

    it('should ignore rows without a known mint or amount', () => {
      // ARRANGE
      expect.assertions(1)
      const rows = [row({ amount: '5', movement: 50, token: 'UNKNOWN' }), row({ amount: null, movement: 10 })]

      // ACT
      const result = aggregateFimsLedgerFlows(rows, mintBySymbol, 1.2)

      // ASSERT
      expect(result).toHaveLength(0)
    })
  })
})

describe('merge-ledger-flows', () => {
  describe('expected behavior', () => {
    it('should let the ledger own priced fields and keep chain quantities', () => {
      // ARRANGE
      expect.assertions(4)
      const chain = [flow({ boughtQty: 99, boughtUsd: 9, qtyIn: 20, qtyOut: 5 })]
      const ledger = [flow({ boughtQty: 15, boughtUsd: 186, soldQty: 4, soldUsd: 54 })]

      // ACT
      const result = mergeLedgerFlows(chain, ledger)

      // ASSERT — priced fields come from the ledger, quantities stay the chain's
      expect(result[0]?.boughtQty).toBe(15)
      expect(result[0]?.boughtUsd).toBe(186)
      expect(result[0]?.qtyIn).toBe(20)
      expect(result[0]?.qtyOut).toBe(5)
    })

    it('should add a flow for a ledger-only mint', () => {
      // ARRANGE
      expect.assertions(2)
      const chain = [flow({ mint: 'other-mint', symbol: 'OTHER' })]
      const ledger = [flow({ boughtQty: 2, mint: 'mint-flip', symbol: 'FLiP' })]

      // ACT
      const result = mergeLedgerFlows(chain, ledger)

      // ASSERT
      expect(result).toHaveLength(2)
      expect(result.find((f) => f.mint === 'mint-flip')?.boughtQty).toBe(2)
    })
  })
})
