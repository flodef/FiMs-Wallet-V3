import { describe, expect, it } from 'vitest'
import { TRANSACTION_FEE_LAMPORTS } from '../src/constants.ts'
import { computeSolSweep, splitIntoBatches } from '../src/plan-wallet-migration.ts'

describe('splitIntoBatches', () => {
  it('should pack items up to the weight cap preserving order', () => {
    // ARRANGE
    expect.assertions(3)
    const items = [3, 1, 2, 3, 1, 1, 3]

    // ACT
    const result = splitIntoBatches(items, (item) => item, 6)

    // ASSERT
    expect(result).toEqual([[3, 1, 2], [3, 1, 1], [3]])
    expect(result.flat()).toEqual(items)
    expect(result.every((batch) => batch.reduce((s, w) => s + w, 0) <= 6)).toBe(true)
  })

  it('should emit a batch for a single item even when it exceeds the cap', () => {
    // ARRANGE
    expect.assertions(1)
    const items = [10]

    // ACT
    const result = splitIntoBatches(items, (item) => item, 6)

    // ASSERT
    expect(result).toEqual([[10]])
  })

  it('should return no batches for an empty input', () => {
    // ARRANGE
    expect.assertions(1)
    const items: number[] = []

    // ACT
    const result = splitIntoBatches(items, (item) => item, 6)

    // ASSERT
    expect(result).toEqual([])
  })
})

describe('computeSolSweep', () => {
  it('should reserve one network fee per batch plus the safety buffer', () => {
    // ARRANGE
    expect.assertions(2)
    const solBalance = BigInt(100_000_000)

    // ACT
    const result = computeSolSweep(solBalance, 3)

    // ASSERT
    expect(result.sufficient).toBe(true)
    expect(result.sweep).toBe(solBalance - TRANSACTION_FEE_LAMPORTS * 3n - 20_000n)
  })

  it('should flag insufficient balance when the reserve exceeds the balance', () => {
    // ARRANGE
    expect.assertions(2)
    const solBalance = TRANSACTION_FEE_LAMPORTS * 2n

    // ACT
    const result = computeSolSweep(solBalance, 5)

    // ASSERT
    expect(result.sufficient).toBe(false)
    expect(result.sweep).toBe(0n)
  })

  it('should leave exactly zero when the balance covers the reserve only', () => {
    // ARRANGE
    expect.assertions(2)
    const solBalance = TRANSACTION_FEE_LAMPORTS + 20_000n

    // ACT
    const result = computeSolSweep(solBalance, 1)

    // ASSERT
    expect(result.sufficient).toBe(false)
    expect(result.sweep).toBe(0n)
  })
})
