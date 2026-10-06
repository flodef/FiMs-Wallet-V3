import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createBackendSigner, signerBackend } from './signer.js'

describe('signerBackend', () => {
  const KEY = 'CUSTODIAL_SIGNER_BACKEND'
  const original = process.env[KEY]

  afterEach(() => {
    if (original === undefined) delete process.env[KEY]
    else process.env[KEY] = original
  })

  describe('expected behavior', () => {
    it('should default to the memory backend when unset', () => {
      // ARRANGE
      expect.assertions(1)
      delete process.env[KEY]

      // ACT
      const result = signerBackend('CUSTODIAL')

      // ASSERT
      expect(result).toBe('memory')
    })

    it('should return the configured backend', () => {
      // ARRANGE
      expect.assertions(1)
      process.env[KEY] = 'gcp_kms'

      // ACT
      const result = signerBackend('CUSTODIAL')

      // ASSERT
      expect(result).toBe('gcp_kms')
    })
  })

  describe('unexpected behavior', () => {
    beforeEach(() => {
      vi.spyOn(console, 'log').mockImplementation(() => {})
    })

    afterEach(() => {
      vi.restoreAllMocks()
    })

    it('should throw on an unknown backend', () => {
      // ARRANGE
      expect.assertions(1)
      process.env[KEY] = 'vault'

      // ACT & ASSERT
      expect(() => signerBackend('CUSTODIAL')).toThrow('CUSTODIAL_SIGNER_BACKEND must be one of')
    })
  })
})

describe('createBackendSigner', () => {
  const KEYS = ['STRATEGY_DELEGATE_GCP_KMS_KEY_NAME', 'STRATEGY_DELEGATE_GCP_KMS_PUBLIC_KEY'] as const
  const originals = new Map(KEYS.map((k) => [k, process.env[k]]))

  afterEach(() => {
    for (const key of KEYS) {
      const value = originals.get(key)
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })

  describe('expected behavior', () => {
    it('should return a Kit-compatible signer for the memory backend', async () => {
      // ARRANGE
      expect.assertions(3)
      // Deterministic 32-byte Ed25519 seed — never a real key.
      const seed = new Uint8Array(32).fill(7)

      // ACT
      const result = await createBackendSigner('CUSTODIAL', () => seed)

      // ASSERT
      expect(result.address).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/)
      expect(typeof result.signTransactions).toBe('function')
      expect(typeof result.isAvailable).toBe('function')
    })
  })

  describe('unexpected behavior', () => {
    beforeEach(() => {
      vi.spyOn(console, 'log').mockImplementation(() => {})
      process.env['STRATEGY_DELEGATE_SIGNER_BACKEND'] = 'gcp_kms'
      delete process.env['STRATEGY_DELEGATE_GCP_KMS_KEY_NAME']
      delete process.env['STRATEGY_DELEGATE_GCP_KMS_PUBLIC_KEY']
    })

    afterEach(() => {
      vi.restoreAllMocks()
      delete process.env['STRATEGY_DELEGATE_SIGNER_BACKEND']
    })

    it('should throw when the gcp_kms backend lacks its config', async () => {
      // ARRANGE
      expect.assertions(1)
      const unused = () => new Uint8Array(32)

      // ACT & ASSERT
      await expect(createBackendSigner('STRATEGY_DELEGATE', unused)).rejects.toThrow(
        'STRATEGY_DELEGATE_GCP_KMS_KEY_NAME and STRATEGY_DELEGATE_GCP_KMS_PUBLIC_KEY are required',
      )
    })

    it('should throw when the gcp_kms backend lacks credentials', async () => {
      // ARRANGE
      expect.assertions(1)
      process.env['STRATEGY_DELEGATE_GCP_KMS_KEY_NAME'] =
        'projects/p/locations/global/keyRings/kr/cryptoKeys/k/cryptoKeyVersions/1'
      process.env['STRATEGY_DELEGATE_GCP_KMS_PUBLIC_KEY'] = 'GyU9ZpTL3ce8kfS6XSpoiXaiiGb9svJfFEWer33SMmPS'
      const savedCredentials = process.env['GOOGLE_APPLICATION_CREDENTIALS']
      const savedJson = process.env['GCP_SA_KEY_JSON']
      delete process.env['GOOGLE_APPLICATION_CREDENTIALS']
      delete process.env['GCP_SA_KEY_JSON']
      const unused = () => new Uint8Array(32)

      try {
        // ACT & ASSERT
        await expect(createBackendSigner('STRATEGY_DELEGATE', unused)).rejects.toThrow(
          'gcp_kms backend needs credentials',
        )
      } finally {
        if (savedCredentials !== undefined) process.env['GOOGLE_APPLICATION_CREDENTIALS'] = savedCredentials
        if (savedJson !== undefined) process.env['GCP_SA_KEY_JSON'] = savedJson
      }
    })
  })
})
