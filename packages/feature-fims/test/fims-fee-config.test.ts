import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  FIMS_TONTINE_MIN_RATE,
  getFimsFeeRate,
  getFimsPlatformFeeBps,
  getFimsTontineRate,
  setFimsFeeRate,
  setFimsTontineRate,
} from '../src/fims-fee-config.ts'

// The config is module-level mutable state — every test restores the
// production defaults so ordering never leaks between cases.
beforeEach(() => {
  setFimsFeeRate(0.002)
  setFimsTontineRate(FIMS_TONTINE_MIN_RATE)
})

describe('fims fee config defaults', () => {
  describe('expected behavior', () => {
    it('should default the operating fee to 0.2% (20 bps)', () => {
      // ARRANGE & ACT & ASSERT
      expect.assertions(2)
      expect(getFimsFeeRate()).toBe(0.002)
      expect(getFimsPlatformFeeBps()).toBe(20)
    })

    it('should default the tontine rate to the 10% minimum', () => {
      // ARRANGE & ACT & ASSERT
      expect.assertions(2)
      expect(getFimsTontineRate()).toBe(0.1)
      expect(FIMS_TONTINE_MIN_RATE).toBe(0.1)
    })
  })
})

describe('setFimsTontineRate', () => {
  describe('expected behavior', () => {
    it('should accept the minimum rate of exactly 10%', () => {
      // ARRANGE & ACT
      setFimsTontineRate(0.1)

      // ASSERT
      expect.assertions(1)
      expect(getFimsTontineRate()).toBe(0.1)
    })

    it('should accept a rate above the 10% minimum', () => {
      // ARRANGE & ACT
      setFimsTontineRate(0.15)

      // ASSERT
      expect.assertions(1)
      expect(getFimsTontineRate()).toBe(0.15)
    })
  })

  describe('unexpected behavior', () => {
    beforeEach(() => {
      vi.spyOn(console, 'log').mockImplementation(() => {})
    })

    afterEach(() => {
      vi.restoreAllMocks()
    })

    it('should reject a rate below the 10% minimum and keep the current value', () => {
      // ARRANGE
      expect.assertions(2)

      // ACT & ASSERT
      expect(() => setFimsTontineRate(0.09)).toThrow(RangeError)
      expect(getFimsTontineRate()).toBe(0.1)
    })

    it('should reject non-finite rates and rates above 100%', () => {
      // ARRANGE
      expect.assertions(3)
      setFimsTontineRate(0.2)

      // ACT & ASSERT
      expect(() => setFimsTontineRate(Number.NaN)).toThrow(RangeError)
      expect(() => setFimsTontineRate(1.5)).toThrow(RangeError)
      expect(getFimsTontineRate()).toBe(0.2)
    })
  })
})

describe('setFimsFeeRate', () => {
  describe('expected behavior', () => {
    it('should accept a new operating fee and reflect it in basis points', () => {
      // ARRANGE & ACT
      setFimsFeeRate(0.002)

      // ASSERT
      expect.assertions(2)
      expect(getFimsFeeRate()).toBe(0.002)
      expect(getFimsPlatformFeeBps()).toBe(20)
    })

    it('should accept zero', () => {
      // ARRANGE & ACT
      setFimsFeeRate(0)

      // ASSERT
      expect.assertions(2)
      expect(getFimsFeeRate()).toBe(0)
      expect(getFimsPlatformFeeBps()).toBe(0)
    })
  })

  describe('unexpected behavior', () => {
    beforeEach(() => {
      vi.spyOn(console, 'log').mockImplementation(() => {})
    })

    afterEach(() => {
      vi.restoreAllMocks()
    })

    it('should reject negative, non-finite and above-ceiling rates', () => {
      // ARRANGE
      expect.assertions(4)

      // ACT & ASSERT
      expect(() => setFimsFeeRate(-0.001)).toThrow(RangeError)
      expect(() => setFimsFeeRate(Number.POSITIVE_INFINITY)).toThrow(RangeError)
      expect(() => setFimsFeeRate(0.5)).toThrow(RangeError)
      expect(getFimsFeeRate()).toBe(0.002)
    })
  })
})
