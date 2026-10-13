import { AppError } from '@workspace/core/app-error'
import {
  decryptWithCredential,
  encryptWithCredential,
  generateVaultKeyMaterial,
  importVaultKey,
} from './encrypted-value.ts'
import {
  encryptedValueSchema,
  VAULT_PIN_CREATE_MIN_LENGTH,
  VAULT_PIN_MAX_LENGTH,
  VAULT_PIN_MIN_LENGTH,
} from './encrypted-value-schema.ts'
import { walletProtectionSchema } from './wallet-protection-schema.ts'

const PIN_DIGITS_REGEX = /^\d+$/

export function createPasswordWalletProtection(): string {
  return JSON.stringify({
    mode: 'password',
    version: 1,
  })
}

export async function createPinWalletProtection(input: { pin: string }): Promise<string> {
  assertPin(input.pin, VAULT_PIN_CREATE_MIN_LENGTH)

  return JSON.stringify({
    keyEnvelope: encryptedValueSchema.parse(
      JSON.parse(
        await encryptWithCredential({
          credential: input.pin,
          maxLength: VAULT_PIN_MAX_LENGTH,
          minLength: VAULT_PIN_CREATE_MIN_LENGTH,
          value: generateVaultKeyMaterial(),
        }),
      ),
    ),
    mode: 'pin',
    version: 1,
  })
}

export function createUnsecuredWalletProtection(): string {
  return JSON.stringify({
    keyMaterial: generateVaultKeyMaterial(),
    mode: 'unsecured',
    version: 1,
  })
}

export function isWalletProtection(value: string): boolean {
  try {
    return walletProtectionSchema.safeParse(JSON.parse(value)).success
  } catch {
    return false
  }
}

export async function unlockPinWalletProtection(input: { pin: string; protection: string }): Promise<CryptoKey> {
  assertPin(input.pin)
  try {
    const protection = walletProtectionSchema.parse(JSON.parse(input.protection))
    if (protection.mode !== 'pin') {
      throw new AppError('walletNotPinProtected', 'Wallet is not PIN protected')
    }
    const keyMaterial = await decryptWithCredential({
      credential: input.pin,
      encrypted: JSON.stringify(protection.keyEnvelope),
    })
    return await importVaultKey({ keyMaterial })
  } catch (error) {
    throw new AppError('walletUnlockFailed', 'Unable to unlock wallet protection', { cause: error })
  }
}

export async function unlockUnsecuredWalletProtection(input: { protection: string }): Promise<CryptoKey> {
  try {
    const protection = walletProtectionSchema.parse(JSON.parse(input.protection))
    if (protection.mode !== 'unsecured') {
      throw new AppError('walletNotUnsecured', 'Wallet is not unsecured')
    }

    return await importVaultKey({ keyMaterial: protection.keyMaterial })
  } catch (error) {
    throw new AppError('walletUnlockFailed', 'Unable to unlock wallet protection', { cause: error })
  }
}

function assertPin(pin: string, minLength = VAULT_PIN_MIN_LENGTH): void {
  if (!PIN_DIGITS_REGEX.test(pin)) {
    throw new AppError('pinDigitsOnly', 'PIN must contain only digits')
  }
  if (pin.length < minLength) {
    throw new AppError('pinTooShort', `PIN must be at least ${minLength} digits`, { count: minLength })
  }
  if (pin.length > VAULT_PIN_MAX_LENGTH) {
    throw new AppError('pinTooLong', `PIN must be at most ${VAULT_PIN_MAX_LENGTH} digits`, {
      count: VAULT_PIN_MAX_LENGTH,
    })
  }
}
