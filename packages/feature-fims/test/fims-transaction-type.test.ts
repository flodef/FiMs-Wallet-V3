import { describe, expect, it } from 'vitest'
import { getFimsTransactionType } from '../src/fims-transaction-type.ts'

describe('get-fims-transaction-type', () => {
  describe('expected behavior', () => {
    it('should derive a deposit when movement is positive and differs from cost', () => {
      // ARRANGE
      expect.assertions(1)
      const transaction = { cost: 5, movement: 100, type: null }

      // ACT
      const result = getFimsTransactionType(transaction)

      // ASSERT
      expect(result).toBe('deposit')
    })

    it('should derive a withdrawal when movement is negative and differs from cost', () => {
      // ARRANGE
      expect.assertions(1)
      const transaction = { cost: 5, movement: -100, type: null }

      // ACT
      const result = getFimsTransactionType(transaction)

      // ASSERT
      expect(result).toBe('withdrawal')
    })

    it('should derive a donation when movement equals cost', () => {
      // ARRANGE
      expect.assertions(1)
      const transaction = { cost: 684.79, movement: 684.79, type: null }

      // ACT
      const result = getFimsTransactionType(transaction)

      // ASSERT
      expect(result).toBe('donation')
    })

    it('should derive a payment when a negative movement equals a negative cost', () => {
      // ARRANGE
      expect.assertions(1)
      const transaction = { cost: -50, movement: -50, type: null }

      // ACT
      const result = getFimsTransactionType(transaction)

      // ASSERT
      expect(result).toBe('payment')
    })

    it('should derive a withdrawal when cost has the opposite sign', () => {
      // ARRANGE
      expect.assertions(1)
      const transaction = { cost: 50, movement: -50, type: null }

      // ACT
      const result = getFimsTransactionType(transaction)

      // ASSERT
      expect(result).toBe('withdrawal')
    })

    it('should prefer the stored type over the derived one', () => {
      // ARRANGE
      expect.assertions(1)
      const transaction = { cost: 50, movement: -50, type: 'tontine' as const }

      // ACT
      const result = getFimsTransactionType(transaction)

      // ASSERT
      expect(result).toBe('tontine')
    })
  })
})
