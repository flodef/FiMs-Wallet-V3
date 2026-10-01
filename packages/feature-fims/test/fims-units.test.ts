import { describe, expect, it } from 'vitest'

import { formatTokenUnits, parseTokenUnits } from '../src/fims-units.ts'

describe('fims-units', () => {
  describe('expected behavior', () => {
    it('should format units with decimals', () => {
      // ARRANGE
      expect.assertions(3)
      const input = 1_234_500_000n

      // ACT
      const result = formatTokenUnits(input, 6)

      // ASSERT
      expect(result).toBe('1234.5')
      expect(formatTokenUnits(5n, 6)).toBe('0.000005')
      expect(formatTokenUnits(1_000_000n, 6)).toBe('1')
    })

    it('should parse a decimal string into base units', () => {
      // ARRANGE
      expect.assertions(3)

      // ACT
      const result = parseTokenUnits('12.5', 6)

      // ASSERT
      expect(result).toBe(12_500_000n)
      expect(parseTokenUnits('0.000001', 6)).toBe(1n)
      expect(parseTokenUnits('1,5', 9)).toBe(1_500_000_000n)
    })

    it('should truncate fractions longer than the decimals', () => {
      // ARRANGE
      expect.assertions(1)

      // ACT
      const result = parseTokenUnits('0.123456789123', 6)

      // ASSERT
      expect(result).toBe(123456n)
    })
  })
})
