import { describe, expect, it } from 'vitest'
import { formatTokenUnits } from './solana-util.js'

describe('format-token-units', () => {
  describe('expected behavior', () => {
    it('should format exact decimal strings for token units', () => {
      // ARRANGE
      expect.assertions(8)

      // ACT & ASSERT
      expect(formatTokenUnits(1_000_000n, 6)).toBe('1')
      expect(formatTokenUnits(1_500_000n, 6)).toBe('1.5')
      expect(formatTokenUnits(-2_500_000n, 6)).toBe('-2.5')
      expect(formatTokenUnits(1n, 6)).toBe('0.000001')
      // 0 decimals: slice(0, -0) === slice(0, 0) must not collapse to '0'.
      expect(formatTokenUnits(123n, 0)).toBe('123')
      expect(formatTokenUnits(0n, 0)).toBe('0')
      // Precision beyond float64 — the reason this helper exists.
      expect(formatTokenUnits(12_345_678_901_234_567_890n, 9)).toBe('12345678901.23456789')
      expect(formatTokenUnits(90n, 9)).toBe('0.00000009')
    })
  })
})
