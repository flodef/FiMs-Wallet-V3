import { getBase58Encoder } from '@solana/codecs-strings'
import { createKeyPairSignerFromPrivateKeyBytes } from '@solana/kit'
// cspell:ignore unstub
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const EURC_MINT = 'HzwqbKZw8HxMN6bF2yFZNrht3c2iXXzpKcFu7uBEDKtr'
const USDG_MINT = '2u1tszSeqZ3qBWF3uNGPFc8TzMk2tdiwknnRMWGWjGWH'
const EURO_PRODUCT_MINT = 'mScYnvWBaGK6jd9ufw2EN7fjDYtAqMeRhJFV6dQ7q1k'
const USD_PRODUCT_MINT = 'wiz2ES5ide7CneSA1wCuVcr4rtxD96MXuLXzqHXxyoc'

// Re-import the module fresh so the cached custodial signer and mint env are
// rebuilt for each test's env setup.
async function loadCustodial() {
  vi.resetModules()
  return await import('./custodial.js')
}

// Build a valid 64-byte ed25519 secret key (32-byte seed + pubkey) from a
// deterministic seed — the JSON array form solana-keygen outputs.
async function testSecretKeyJson(): Promise<{ json: string; address: string }> {
  const seed = Uint8Array.from(Array(32).fill(9))
  const signer = await createKeyPairSignerFromPrivateKeyBytes(seed)
  const publicKey = getBase58Encoder().encode(signer.address)
  return { address: signer.address, json: JSON.stringify([...seed, ...publicKey]) }
}

describe('custodial', () => {
  beforeEach(() => {
    vi.unstubAllEnvs()
    vi.stubEnv('FIMS_EURO_MINT', '')
    vi.stubEnv('FIMS_USD_MINT', '')
    vi.stubEnv('FIMS_EURO_BACKING_MINT', '')
    vi.stubEnv('FIMS_USD_BACKING_MINT', '')
    vi.stubEnv('CUSTODIAL_KEYPAIR', '')
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  describe('wrappedProductConfig', () => {
    it('should return null when the product mint env is not set', async () => {
      // ARRANGE
      expect.assertions(2)
      const { wrappedProductConfig } = await loadCustodial()

      // ACT
      const result = wrappedProductConfig('fims-eur')
      const result2 = wrappedProductConfig('fims-usd')

      // ASSERT
      expect(result).toBeNull()
      expect(result2).toBeNull()
    })

    it('should pin the mainnet backing mints when no override is set', async () => {
      // ARRANGE
      expect.assertions(5)
      vi.stubEnv('FIMS_EURO_MINT', EURO_PRODUCT_MINT)
      vi.stubEnv('FIMS_USD_MINT', USD_PRODUCT_MINT)
      const { wrappedProductConfig } = await loadCustodial()

      // ACT
      const result = wrappedProductConfig('fims-eur')
      const result2 = wrappedProductConfig('fims-usd')

      // ASSERT
      expect(result).toEqual({
        backingMint: EURC_MINT,
        mint: EURO_PRODUCT_MINT,
        symbol: 'EURF',
        units: 1_000_000n,
      })
      expect(result2?.backingMint).toBe(USDG_MINT)
      expect(result2?.symbol).toBe('USDF')
      expect(result?.mint).toBe(EURO_PRODUCT_MINT)
      expect(result?.units).toBe(1_000_000n)
    })

    it('should use the backing mint override when set', async () => {
      // ARRANGE
      expect.assertions(1)
      const backing = '6tk8SKYecD4p5Myc9ngUhoVj4h33xBZ3L1fYrELdGuBg'
      vi.stubEnv('FIMS_EURO_MINT', EURO_PRODUCT_MINT)
      vi.stubEnv('FIMS_EURO_BACKING_MINT', backing)
      const { wrappedProductConfig } = await loadCustodial()

      // ACT
      const result = wrappedProductConfig('fims-eur')

      // ASSERT
      expect(result?.backingMint).toBe(backing)
    })
  })

  describe('productForBackingMint / productForWrappedMint', () => {
    beforeEach(() => {
      vi.stubEnv('FIMS_EURO_MINT', EURO_PRODUCT_MINT)
      vi.stubEnv('FIMS_USD_MINT', USD_PRODUCT_MINT)
    })

    it('should resolve each configured product from its backing mint', async () => {
      // ARRANGE
      expect.assertions(3)
      const { productForBackingMint } = await loadCustodial()

      // ACT
      const result = productForBackingMint(EURC_MINT)
      const result2 = productForBackingMint(USDG_MINT)
      const result3 = productForBackingMint('So11111111111111111111111111111111111111112')

      // ASSERT
      expect(result).toBe('fims-eur')
      expect(result2).toBe('fims-usd')
      expect(result3).toBeNull()
    })

    it('should resolve each configured product from its wrapped mint', async () => {
      // ARRANGE
      expect.assertions(3)
      const { productForWrappedMint } = await loadCustodial()

      // ACT
      const result = productForWrappedMint(EURO_PRODUCT_MINT)
      const result2 = productForWrappedMint(USD_PRODUCT_MINT)
      const result3 = productForWrappedMint(EURC_MINT)

      // ASSERT
      expect(result).toBe('fims-eur')
      expect(result2).toBe('fims-usd')
      expect(result3).toBeNull()
    })

    it('should return null for every mint when no product is configured', async () => {
      // ARRANGE
      expect.assertions(2)
      vi.stubEnv('FIMS_EURO_MINT', '')
      vi.stubEnv('FIMS_USD_MINT', '')
      const { productForBackingMint, productForWrappedMint } = await loadCustodial()

      // ACT
      const result = productForBackingMint(EURC_MINT)
      const result2 = productForWrappedMint(EURO_PRODUCT_MINT)

      // ASSERT
      expect(result).toBeNull()
      expect(result2).toBeNull()
    })
  })

  describe('custodialAddress', () => {
    it('should derive the custody address from a JSON secret key', async () => {
      // ARRANGE
      expect.assertions(1)
      const { address, json } = await testSecretKeyJson()
      vi.stubEnv('CUSTODIAL_KEYPAIR', json)
      const { custodialAddress } = await loadCustodial()

      // ACT
      const result = await custodialAddress()

      // ASSERT
      expect(result).toBe(address)
    })
  })

  describe('custodialMint', () => {
    it('should reject before touching the network when the product mint is not configured', async () => {
      // ARRANGE
      expect.assertions(1)
      const { custodialMint } = await loadCustodial()

      // ACT & ASSERT
      await expect(custodialMint('fims-eur', 'Member111111111111111111111111111111111' as never, 1n)).rejects.toThrow(
        'fims-eur mint is not configured',
      )
    })
  })

  describe('unexpected behavior', () => {
    beforeEach(() => {
      vi.spyOn(console, 'log').mockImplementation(() => {})
    })

    afterEach(() => {
      vi.restoreAllMocks()
    })

    it('should throw when CUSTODIAL_KEYPAIR is not configured', async () => {
      // ARRANGE
      expect.assertions(1)
      const { custodialAddress } = await loadCustodial()

      // ACT & ASSERT
      await expect(custodialAddress()).rejects.toThrow('CUSTODIAL_KEYPAIR is not configured')
    })

    it('should throw when the secret key is not 64 bytes', async () => {
      // ARRANGE
      expect.assertions(1)
      vi.stubEnv('CUSTODIAL_KEYPAIR', '[1,2,3]')
      const { custodialAddress } = await loadCustodial()

      // ACT & ASSERT
      await expect(custodialAddress()).rejects.toThrow('CUSTODIAL_KEYPAIR must be a 64-byte secret key')
    })

    it('should throw on an invalid base58 character in the secret key', async () => {
      // ARRANGE
      expect.assertions(1)
      vi.stubEnv('CUSTODIAL_KEYPAIR', 'has0invalid-characters')
      const { custodialAddress } = await loadCustodial()

      // ACT & ASSERT
      await expect(custodialAddress()).rejects.toThrow('CUSTODIAL_KEYPAIR: invalid base58 character')
    })
  })
})
