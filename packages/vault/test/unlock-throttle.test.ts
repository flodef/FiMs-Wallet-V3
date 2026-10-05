import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  checkUnlockThrottle,
  clearUnlockThrottle,
  recordUnlockFailure,
  resetUnlockThrottle,
} from '../src/unlock-throttle.ts'
import { createVault, type VaultStorage } from '../src/vault.ts'
import { createPinWalletProtection } from '../src/wallet-protection.ts'

let vaultKey: string | undefined
const walletProtections = new Map<string, string>()
const storage: VaultStorage = {
  async getVaultKey() {
    return vaultKey
  },
  async getWalletProtection(walletId) {
    const protection = walletProtections.get(walletId)
    if (!protection) {
      throw new Error(`Wallet with id ${walletId} not found`)
    }

    return protection
  },
  async setVaultKey(value) {
    vaultKey = value
  },
}

describe('unlock-throttle', () => {
  beforeEach(() => {
    vaultKey = undefined
    walletProtections.clear()
    resetUnlockThrottle()
    vi.useRealTimers()
  })

  describe('expected behavior', () => {
    it('should allow the first failures without delay', async () => {
      // ARRANGE
      expect.assertions(2)

      // ACT
      recordUnlockFailure('target')
      recordUnlockFailure('target')

      // ASSERT
      expect(() => checkUnlockThrottle('target')).not.toThrow()
      recordUnlockFailure('target')
      expect(() => checkUnlockThrottle('target')).toThrow('Too many failed attempts')
    })

    it('should increase the delay with each extra failure', async () => {
      // ARRANGE
      expect.assertions(3)
      vi.useFakeTimers()
      vi.setSystemTime(0)
      for (let i = 0; i < 3; i++) {
        recordUnlockFailure('target')
      }

      // ACT & ASSERT
      expect(() => checkUnlockThrottle('target')).toThrow('try again in 15s')
      vi.setSystemTime(15_001)
      expect(() => checkUnlockThrottle('target')).not.toThrow()
      recordUnlockFailure('target')
      expect(() => checkUnlockThrottle('target')).toThrow('try again in 30s')
    })

    it('should reset the counter after a success', async () => {
      // ARRANGE
      expect.assertions(1)
      recordUnlockFailure('target')
      recordUnlockFailure('target')
      recordUnlockFailure('target')

      // ACT
      clearUnlockThrottle('target')

      // ASSERT
      expect(() => checkUnlockThrottle('target')).not.toThrow()
    })

    it('should throttle vault unlock after repeated wrong passwords', async () => {
      // ARRANGE
      expect.assertions(4)
      const vault = createVault(storage)
      await vault.create({ password: 'password-one' })
      vault.lock()

      // ACT & ASSERT
      await expect(vault.unlock({ password: 'wrong' })).rejects.toThrow('Unable to unlock vault')
      await expect(vault.unlock({ password: 'wrong' })).rejects.toThrow('Unable to unlock vault')
      await expect(vault.unlock({ password: 'wrong' })).rejects.toThrow('Unable to unlock vault')
      await expect(vault.unlock({ password: 'password-one' })).rejects.toThrow('Too many failed attempts')
    })

    it('should clear the throttle after a successful vault unlock', async () => {
      // ARRANGE
      expect.assertions(2)
      const vault = createVault(storage)
      await vault.create({ password: 'password-one' })
      vault.lock()
      await vault.unlock({ password: 'wrong' }).catch(() => {})

      // ACT
      await vault.unlock({ password: 'password-one' })
      vault.lock()

      // ASSERT
      expect(vault.isUnlocked()).toBe(false)
      await expect(vault.unlock({ password: 'password-one' })).resolves.toBeUndefined()
    })

    it('should throttle PIN unlock attempts per wallet', async () => {
      // ARRANGE
      expect.assertions(5)
      const vault = createVault(storage)
      const protection = await createPinWalletProtection({ pin: '12345678' })
      walletProtections.set('wallet-pin', protection)
      walletProtections.set('wallet-other', protection)

      // ACT & ASSERT
      for (let i = 0; i < 3; i++) {
        await expect(vault.unlockWallet({ credential: '00000000', walletId: 'wallet-pin' })).rejects.toThrow(
          'Unable to unlock wallet',
        )
      }
      await expect(vault.unlockWallet({ credential: '12345678', walletId: 'wallet-pin' })).rejects.toThrow(
        'Too many failed attempts',
      )
      await expect(vault.unlockWallet({ credential: '12345678', walletId: 'wallet-other' })).resolves.toBeUndefined()
    })
  })
})
