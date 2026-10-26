import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { parsePriceSheet, sheetDate } from './price-sync.ts'

const SHEET = [
  ['Date', 'EUR to USD (EURC)', 'FiMs SOL (FSOL)'],
  [46321, 1.1176, 110.64],
  [46320, 1.1208, ''],
  [46319, 1.1187, 110.05],
]

describe('parse-price-sheet', () => {
  describe('expected behavior', () => {
    it('should turn each dated row into one point per priced series', () => {
      // ARRANGE
      expect.assertions(3)

      // ACT
      const result = parsePriceSheet(SHEET)

      // ASSERT
      expect(result).toHaveLength(5)
      expect(result[0]).toEqual({ date: sheetDate(46321), price: 1.1176, token: 'EUR to USD (EURC)' })
      expect(
        result.some((r) => r.token === 'FiMs SOL (FSOL)' && r.date.getTime() === sheetDate(46320)?.getTime()),
      ).toBe(false)
    })

    it('should skip rows dated on or before the cutoff', () => {
      // ARRANGE
      expect.assertions(1)
      const after = sheetDate(46320)

      // ACT
      const result = parsePriceSheet(SHEET, after)

      // ASSERT
      expect(result.map((r) => r.date.getTime())).toEqual([sheetDate(46321)?.getTime(), sheetDate(46321)?.getTime()])
    })

    it('should convert a Sheets serial date to the calendar day', () => {
      // ARRANGE
      expect.assertions(1)

      // ACT
      const result = sheetDate(46321)

      // ASSERT
      expect(result?.toISOString().slice(0, 10)).toBe('2026-10-26')
    })
  })

  describe('unexpected behavior', () => {
    beforeEach(() => {
      vi.spyOn(console, 'log').mockImplementation(() => {})
    })

    afterEach(() => {
      vi.restoreAllMocks()
    })

    it('should return nothing when the Date header row is missing', () => {
      // ARRANGE
      expect.assertions(1)

      // ACT
      const result = parsePriceSheet([
        ['Foo', 'Bar'],
        [1, 2],
      ])

      // ASSERT
      expect(result).toEqual([])
    })

    it('should drop zero, negative and non-numeric prices', () => {
      // ARRANGE
      expect.assertions(1)

      // ACT
      const result = parsePriceSheet([
        ['Date', 'A (A)', 'B (B)', 'C (C)'],
        [46321, 0, -1, 'n/a'],
      ])

      // ASSERT
      expect(result).toEqual([])
    })
  })
})
