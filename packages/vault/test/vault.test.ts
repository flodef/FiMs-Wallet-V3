import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  decryptWithPassword,
  encryptWithCredential,
  generateVaultKeyMaterial,
  kdfIterations,
} from '../src/encrypted-value.ts'
import { resetUnlockThrottle } from '../src/unlock-throttle.ts'
import { createVault, type VaultStorage } from '../src/vault.ts'

let vaultKey: string | undefined
const storage: VaultStorage = {
  async getVaultKey() {
    return vaultKey
  },
  async getWalletProtection() {
    throw new Error('Wallet protection is not configured')
  },
  async setVaultKey(value) {
    vaultKey = value
  },
}

// Wraps fresh key material under a credential at an arbitrary PBKDF2
// iteration count — the way pre-hardening builds wrote vault keys before the
// current 600k floor.
async function legacyVaultKey(credential: string, iterations: number): Promise<string> {
  const keyMaterial = generateVaultKeyMaterial()
  const salt = crypto.getRandomValues(new Uint8Array(16))
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const baseKey = await crypto.subtle.importKey('raw', new TextEncoder().encode(credential), 'PBKDF2', false, [
    'deriveKey',
  ])
  const key = await crypto.subtle.deriveKey(
    { hash: 'SHA-256', iterations, name: 'PBKDF2', salt },
    baseKey,
    { length: 256, name: 'AES-GCM' },
    false,
    ['encrypt'],
  )
  const encrypted = new Uint8Array(
    await crypto.subtle.encrypt({ iv, name: 'AES-GCM' }, key, new TextEncoder().encode(keyMaterial)),
  )
  const b64 = (v: Uint8Array) =>
    btoa(String.fromCharCode(...v))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/g, '')
  return JSON.stringify({
    auth_tag: b64(encrypted.slice(encrypted.length - 16)),
    cipher: 'aes-256-gcm',
    cipherparams: { iv: b64(iv) },
    ciphertext: b64(encrypted.slice(0, encrypted.length - 16)),
    kdf: 'pbkdf2-sha256',
    kdfparams: { dklen: 32, hash: 'sha256', iterations, salt: b64(salt) },
    version: 1,
  })
}

async function legacyPinProtection(pin: string): Promise<string> {
  const keyEnvelope = JSON.parse(
    await encryptWithCredential({ credential: pin, minLength: 1, value: generateVaultKeyMaterial() }),
  )
  return JSON.stringify({ keyEnvelope, mode: 'pin', version: 1 })
}

describe('vault', () => {
  beforeEach(() => {
    vaultKey = undefined
    resetUnlockThrottle()
  })

  describe('expected behavior', () => {
    it('should create and store a wrapped vault key', async () => {
      // ARRANGE
      expect.assertions(3)
      const vault = createVault(storage)

      // ACT
      await vault.create({ password: 'password-one' })

      // ASSERT
      expect(vaultKey).toBeDefined()
      expect(vaultKey).not.toContain('password-one')
      expect(vault.isUnlocked()).toBe(true)
    })

    it('should unlock an existing vault', async () => {
      // ARRANGE
      expect.assertions(2)
      const vault1 = createVault(storage)
      await vault1.create({ password: 'password-one' })
      vault1.lock()
      const vault2 = createVault(storage)

      // ACT
      await vault2.unlock({ password: 'password-one' })

      // ASSERT
      expect(vault1.isUnlocked()).toBe(false)
      expect(vault2.isUnlocked()).toBe(true)
    })

    it('should unlock with recovered key material instead of the password', async () => {
      // ARRANGE
      expect.assertions(2)
      const vault = createVault(storage)
      await vault.create({ password: 'password-one' })
      const keyMaterial = await decryptWithPassword({ encrypted: vaultKey as string, password: 'password-one' })
      vault.lock()
      const vault2 = createVault(storage)

      // ACT
      await vault2.unlockWithKeyMaterial({ keyMaterial })

      // ASSERT
      expect(vault.isUnlocked()).toBe(false)
      expect(vault2.requireDefaultKey()).toBeDefined()
    })

    it('should report a legacy short password as a weak credential after unlock', async () => {
      // ARRANGE
      expect.assertions(2)
      vaultKey = await legacyVaultKey('short-pass', 600_000)
      const vault = createVault(storage)

      // ACT
      await vault.unlock({ password: 'short-pass' })

      // ASSERT
      expect(vault.isUnlocked()).toBe(true)
      expect(vault.weakCredentials()).toEqual({ password: true, walletIds: [] })
    })

    it('should report no weak credential for a compliant password', async () => {
      // ARRANGE
      expect.assertions(1)
      const vault = createVault(storage)
      await vault.create({ password: 'password-one' })

      // ACT
      const weak = vault.weakCredentials()

      // ASSERT
      expect(weak).toEqual({ password: false, walletIds: [] })
    })

    it('should report a legacy short PIN as a weak credential after wallet unlock', async () => {
      // ARRANGE
      expect.assertions(2)
      const protection = await legacyPinProtection('1234')
      const vault = createVault({
        ...storage,
        async getWalletProtection() {
          return protection
        },
      })

      // ACT
      await vault.unlockWallet({ credential: '1234', walletId: 'wallet-one' })

      // ASSERT
      expect(vault.weakCredentials().walletIds).toEqual(['wallet-one'])
      expect(vault.weakCredentials().password).toBe(false)
    })

    it('should clear the weak PIN flag when the wallet unlocks with a compliant PIN', async () => {
      // ARRANGE
      expect.assertions(2)
      const weakProtection = await legacyPinProtection('1234')
      const strongProtection = await legacyPinProtection('12345678')
      let protection = weakProtection
      const vault = createVault({
        ...storage,
        async getWalletProtection() {
          return protection
        },
      })
      await vault.unlockWallet({ credential: '1234', walletId: 'wallet-one' })

      // ACT
      protection = strongProtection
      await vault.unlockWallet({ credential: '12345678', walletId: 'wallet-one' })

      // ASSERT
      expect(vault.weakCredentials().walletIds).toEqual([])
      expect(vault.weakCredentials().password).toBe(false)
    })

    it('should clear weak credentials on lock', async () => {
      // ARRANGE
      expect.assertions(2)
      vaultKey = await legacyVaultKey('short-pass', 600_000)
      const vault = createVault(storage)
      await vault.unlock({ password: 'short-pass' })

      // ACT
      vault.lock()

      // ASSERT
      expect(vault.weakCredentials()).toEqual({ password: false, walletIds: [] })
      expect(vault.isUnlocked()).toBe(false)
    })

    it('should clear the weak password flag after a password change', async () => {
      // ARRANGE
      expect.assertions(2)
      vaultKey = await legacyVaultKey('short-pass', 600_000)
      const vault = createVault(storage)
      await vault.unlock({ password: 'short-pass' })

      // ACT
      await vault.changePassword({ newPassword: 'new-password-long', oldPassword: 'short-pass' })

      // ASSERT
      expect(vault.weakCredentials().password).toBe(false)
      await expect(
        decryptWithPassword({ encrypted: vaultKey as string, password: 'new-password-long' }),
      ).resolves.toBeDefined()
    })

    it('should re-encrypt a low-iteration envelope at the current KDF floor on unlock', async () => {
      // ARRANGE
      expect.assertions(2)
      vaultKey = await legacyVaultKey('password-one', 100_000)
      const vault = createVault(storage)

      // ACT
      await vault.unlock({ password: 'password-one' })

      // ASSERT
      expect(vault.isUnlocked()).toBe(true)
      expect(kdfIterations(vaultKey as string)).toBe(600_000)
    })

    it('should keep a low-iteration envelope when the password is below the creation minimum', async () => {
      // ARRANGE
      expect.assertions(2)
      vaultKey = await legacyVaultKey('short-pass', 100_000)
      const vault = createVault(storage)

      // ACT
      await vault.unlock({ password: 'short-pass' })

      // ASSERT
      expect(kdfIterations(vaultKey as string)).toBe(100_000)
      expect(vault.weakCredentials().password).toBe(true)
    })
  })

  describe('unexpected behavior', () => {
    beforeEach(() => {
      vi.spyOn(console, 'log').mockImplementation(() => {})
    })

    afterEach(() => {
      vi.restoreAllMocks()
    })

    it('should reject unlock before setup', async () => {
      // ARRANGE
      expect.assertions(1)
      const vault = createVault(storage)

      // ACT & ASSERT
      await expect(vault.unlock({ password: 'password-one' })).rejects.toThrow('Vault is not configured')
    })

    it('should stay locked when create persistence fails', async () => {
      // ARRANGE
      expect.assertions(3)
      const vault = createVault({
        async getVaultKey() {
          return undefined
        },
        async getWalletProtection() {
          throw new Error('Wallet protection is not configured')
        },
        async setVaultKey() {
          throw new Error('storage unavailable')
        },
      })

      // ACT & ASSERT
      await expect(vault.create({ password: 'password-one' })).rejects.toThrow('storage unavailable')
      expect(vault.isUnlocked()).toBe(false)
      await expect(vault.isConfigured()).resolves.toBe(false)
    })

    it('should stay locked when create rejects a short password', async () => {
      // ARRANGE
      expect.assertions(3)
      const vault = createVault(storage)

      // ACT & ASSERT
      await expect(vault.create({ password: 'short' })).rejects.toThrow('Password must be at least 12 characters')
      expect(vault.isUnlocked()).toBe(false)
      await expect(vault.isConfigured()).resolves.toBe(false)
    })

    it('should clear stale state when unlock fails', async () => {
      // ARRANGE
      expect.assertions(3)
      const vault = createVault(storage)
      await vault.create({ password: 'password-one' })

      // ACT & ASSERT
      await expect(vault.unlock({ password: 'wrong-password' })).rejects.toMatchObject({
        cause: expect.objectContaining({ message: 'Unable to decrypt value' }),
        message: 'Unable to unlock vault',
      })
      expect(vault.isUnlocked()).toBe(false)
      expect(() => vault.requireDefaultKey()).toThrow('Vault is locked')
    })

    it('should preserve the original error when changing password fails', async () => {
      // ARRANGE
      expect.assertions(1)
      const vault = createVault(storage)
      await vault.create({ password: 'password-one' })

      // ACT & ASSERT
      await expect(
        vault.changePassword({ newPassword: 'password-two', oldPassword: 'wrong-password' }),
      ).rejects.toMatchObject({
        cause: expect.objectContaining({ message: 'Unable to decrypt value' }),
        message: 'Unable to change vault password',
      })
    })

    it('should reject wrong password', async () => {
      // ARRANGE
      expect.assertions(1)
      const vault = createVault(storage)
      await vault.create({ password: 'password-one' })
      vault.lock()

      // ACT & ASSERT
      await expect(vault.unlock({ password: 'wrong-password' })).rejects.toMatchObject({
        cause: expect.objectContaining({ message: 'Unable to decrypt value' }),
        message: 'Unable to unlock vault',
      })
    })
  })
})
