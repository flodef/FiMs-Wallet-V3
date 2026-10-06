import {
  decryptWithPassword,
  encryptWithPassword,
  generateVaultKeyMaterial,
  importVaultKey,
  kdfIterations,
} from './encrypted-value.ts'
import {
  PASSWORD_KDF_MIN_ITERATIONS,
  VAULT_PASSWORD_CREATE_MIN_LENGTH,
  VAULT_PIN_CREATE_MIN_LENGTH,
} from './encrypted-value-schema.ts'
import { checkUnlockThrottle, clearUnlockThrottle, recordUnlockFailure } from './unlock-throttle.ts'
import { unlockPinWalletProtection, unlockUnsecuredWalletProtection } from './wallet-protection.ts'
import { walletProtectionSchema } from './wallet-protection-schema.ts'

export interface VaultStorage {
  getVaultKey(): Promise<string | undefined>
  getWalletProtection(walletId: string): Promise<string>
  setVaultKey(value: string): Promise<void>
}

export interface Vault {
  changePassword(input: { newPassword: string; oldPassword: string }): Promise<void>
  clearWalletKey(input: { walletId: string }): void
  create(input: { password: string }): Promise<void>
  isConfigured(): Promise<boolean>
  isUnlocked(): boolean
  lock(): void
  requireDefaultKey(): CryptoKey
  requireWalletKey(input: { walletId: string }): Promise<CryptoKey>
  unlock(input: { password: string }): Promise<void>
  unlockWallet(input: { credential: string; walletId: string }): Promise<void>
  unlockWithKeyMaterial(input: { keyMaterial: string }): Promise<void>
  // Credentials still accepted for legacy data but below the current creation
  // minimums — a weak vault password (< 12 chars) or wallet PIN (< 8 digits)
  // should be rotated, the UI nudges the user toward it after unlock.
  weakCredentials(): { password: boolean; walletIds: string[] }
}

export function createVault(store: VaultStorage): Vault {
  let key: CryptoKey | null = null
  let weakPassword = false
  const weakPinWalletIds = new Set<string>()
  const walletKeys = new Map<string, CryptoKey>()

  async function getWalletProtection(walletId: string) {
    return walletProtectionSchema.parse(JSON.parse(await store.getWalletProtection(walletId)))
  }

  async function isConfigured(): Promise<boolean> {
    return Boolean(await store.getVaultKey())
  }

  function requireDefaultKey(): CryptoKey {
    if (!key) {
      throw new Error('Vault is locked')
    }
    return key
  }

  return {
    async changePassword({ newPassword, oldPassword }) {
      const encryptedVaultKey = await store.getVaultKey()
      if (!encryptedVaultKey) {
        throw new Error('Vault is not configured')
      }
      try {
        const keyMaterial = await decryptWithPassword({ encrypted: encryptedVaultKey, password: oldPassword })
        await store.setVaultKey(await encryptWithPassword({ password: newPassword, value: keyMaterial }))
        key = await importVaultKey({ keyMaterial })
        weakPassword = false
      } catch (error) {
        throw new Error('Unable to change vault password', { cause: error })
      }
    },
    clearWalletKey({ walletId }) {
      walletKeys.delete(walletId)
      weakPinWalletIds.delete(walletId)
    },
    async create({ password }) {
      if (await isConfigured()) {
        throw new Error('Vault is already configured')
      }
      const keyMaterial = generateVaultKeyMaterial()
      await store.setVaultKey(await encryptWithPassword({ password, value: keyMaterial }))
      key = await importVaultKey({ keyMaterial })
    },
    isConfigured,
    isUnlocked() {
      return key !== null
    },
    lock() {
      key = null
      weakPassword = false
      weakPinWalletIds.clear()
      walletKeys.clear()
    },
    requireDefaultKey,
    async requireWalletKey({ walletId }) {
      const protection = await getWalletProtection(walletId)
      switch (protection.mode) {
        case 'password':
          return requireDefaultKey()
        case 'pin': {
          const walletKey = walletKeys.get(walletId)
          if (!walletKey) {
            throw new Error('Wallet is locked')
          }
          return walletKey
        }
        case 'unsecured': {
          const walletKey = walletKeys.get(walletId)
          if (walletKey) {
            return walletKey
          }
          const newKey = await unlockUnsecuredWalletProtection({ protection: JSON.stringify(protection) })
          walletKeys.set(walletId, newKey)
          return newKey
        }
      }
    },
    async unlock({ password }) {
      const encryptedVaultKey = await store.getVaultKey()
      if (!encryptedVaultKey) {
        throw new Error('Vault is not configured')
      }
      checkUnlockThrottle('vault')
      try {
        const keyMaterial = await decryptWithPassword({ encrypted: encryptedVaultKey, password })
        // Transparent KDF upgrade: an envelope wrapped under an older,
        // weaker iteration count is re-wrapped at the current policy in the
        // same unlock. Skipped when the password itself is below the
        // creation minimum — re-encrypting would fail the length check, and
        // the weak-password flag already pushes the user toward rotation.
        const iterations = kdfIterations(encryptedVaultKey)
        if (iterations !== null && iterations < PASSWORD_KDF_MIN_ITERATIONS) {
          if (password.length >= VAULT_PASSWORD_CREATE_MIN_LENGTH) {
            await store.setVaultKey(await encryptWithPassword({ password, value: keyMaterial }))
          }
        }
        key = await importVaultKey({ keyMaterial })
        weakPassword = password.length < VAULT_PASSWORD_CREATE_MIN_LENGTH
        clearUnlockThrottle('vault')
      } catch (error) {
        key = null
        weakPassword = false
        walletKeys.clear()
        recordUnlockFailure('vault')
        throw new Error('Unable to unlock vault', { cause: error })
      }
    },
    async unlockWallet({ credential, walletId }) {
      const protection = await getWalletProtection(walletId)
      const throttleTarget = `wallet:${walletId}`
      if (protection.mode === 'pin') {
        checkUnlockThrottle(throttleTarget)
      }
      try {
        switch (protection.mode) {
          case 'password':
            requireDefaultKey()
            return
          case 'pin':
            try {
              walletKeys.set(
                walletId,
                await unlockPinWalletProtection({ pin: credential, protection: JSON.stringify(protection) }),
              )
              if (credential.length < VAULT_PIN_CREATE_MIN_LENGTH) {
                weakPinWalletIds.add(walletId)
              } else {
                weakPinWalletIds.delete(walletId)
              }
              clearUnlockThrottle(throttleTarget)
            } catch (error) {
              recordUnlockFailure(throttleTarget)
              throw error
            }
            return
          case 'unsecured':
            walletKeys.set(walletId, await unlockUnsecuredWalletProtection({ protection: JSON.stringify(protection) }))
            return
        }
      } catch (error) {
        throw new Error('Unable to unlock wallet', { cause: error })
      }
    },
    async unlockWithKeyMaterial({ keyMaterial }) {
      try {
        key = await importVaultKey({ keyMaterial })
      } catch (error) {
        key = null
        walletKeys.clear()
        throw new Error('Unable to unlock vault', { cause: error })
      }
    },
    weakCredentials() {
      return { password: weakPassword, walletIds: [...weakPinWalletIds] }
    },
  }
}
