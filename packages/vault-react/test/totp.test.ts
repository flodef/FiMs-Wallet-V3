import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { generateTotpSecret, totp, totpUri, verifyTotp } from '../src/data-access/totp.ts'

// RFC 6238 test key: ASCII '12345678901234567890' in base32.
// cspell:disable-next-line
const RFC_SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'

describe('generateTotpSecret', () => {
  describe('expected behavior', () => {
    it('should produce a base32-encoded 20-byte secret', () => {
      // ARRANGE
      expect.assertions(2)

      // ACT
      const result = generateTotpSecret()

      // ASSERT
      expect(result).toMatch(/^[A-Z2-7]+$/)
      // 160 bits encode to exactly 32 base32 characters.
      expect(result).toHaveLength(32)
    })
  })
})

describe('totpUri', () => {
  describe('expected behavior', () => {
    it('should build an otpauth URI carrying issuer, account and secret', () => {
      // ARRANGE
      expect.assertions(3)

      // ACT
      const result = totpUri({ account: 'vault', issuer: 'FiMs Wallet', secret: 'ABC' })

      // ASSERT
      expect(result).toContain('otpauth://totp/FiMs%20Wallet:vault')
      expect(result).toContain('secret=ABC')
      expect(result).toContain('issuer=FiMs+Wallet')
    })
  })
})

describe('totp', () => {
  describe('expected behavior', () => {
    it('should match the RFC 6238 SHA-1 test vector at T=59s', async () => {
      // ARRANGE
      expect.assertions(1)

      // ACT
      // RFC 6238 gives the 8-digit value 94287082; we truncate to 6 digits.
      const result = await totp({ secret: RFC_SECRET, timestamp: 59_000 })

      // ASSERT
      expect(result).toBe('287082')
    })

    it('should match the RFC 6238 SHA-1 test vector at T=1111111109s', async () => {
      // ARRANGE
      expect.assertions(1)

      // ACT
      // RFC 6238 gives the 8-digit value 07081804; we truncate to 6 digits.
      const result = await totp({ secret: RFC_SECRET, timestamp: 1_111_111_109_000 })

      // ASSERT
      expect(result).toBe('081804')
    })
  })
})

describe('verifyTotp', () => {
  describe('expected behavior', () => {
    it('should accept the current code', async () => {
      // ARRANGE
      expect.assertions(1)
      const timestamp = 1_700_000_000_000
      const code = await totp({ secret: RFC_SECRET, timestamp })

      // ACT
      const result = await verifyTotp({ code, secret: RFC_SECRET, timestamp })

      // ASSERT
      expect(result).toBe(true)
    })

    it('should accept a code one step in the past or future', async () => {
      // ARRANGE
      expect.assertions(2)
      const timestamp = 1_700_000_000_000
      const previous = await totp({ secret: RFC_SECRET, timestamp: timestamp - 30_000 })
      const next = await totp({ secret: RFC_SECRET, timestamp: timestamp + 30_000 })

      // ACT
      const result = await verifyTotp({ code: previous, secret: RFC_SECRET, timestamp })
      const result1 = await verifyTotp({ code: next, secret: RFC_SECRET, timestamp })

      // ASSERT
      expect(result).toBe(true)
      expect(result1).toBe(true)
    })
  })

  describe('unexpected behavior', () => {
    beforeEach(() => {
      vi.spyOn(console, 'log').mockImplementation(() => {})
    })

    afterEach(() => {
      vi.restoreAllMocks()
    })

    it('should reject a wrong code', async () => {
      // ARRANGE
      expect.assertions(1)
      const timestamp = 1_700_000_000_000

      // ACT
      const result = await verifyTotp({ code: '000001', secret: RFC_SECRET, timestamp })

      // ASSERT
      expect(result).toBe(false)
    })

    it('should reject a code two steps away from now', async () => {
      // ARRANGE
      expect.assertions(1)
      const timestamp = 1_700_000_000_000
      const far = await totp({ secret: RFC_SECRET, timestamp: timestamp - 60_000 })

      // ACT
      const result = await verifyTotp({ code: far, secret: RFC_SECRET, timestamp })

      // ASSERT
      expect(result).toBe(false)
    })

    it('should reject input that is not six digits', async () => {
      // ARRANGE
      expect.assertions(3)
      const timestamp = 1_700_000_000_000

      // ACT
      const result = await verifyTotp({ code: '12345', secret: RFC_SECRET, timestamp })
      const result1 = await verifyTotp({ code: 'abcdef', secret: RFC_SECRET, timestamp })
      const result2 = await verifyTotp({ code: '', secret: RFC_SECRET, timestamp })

      // ASSERT
      expect(result).toBe(false)
      expect(result1).toBe(false)
      expect(result2).toBe(false)
    })
  })
})
