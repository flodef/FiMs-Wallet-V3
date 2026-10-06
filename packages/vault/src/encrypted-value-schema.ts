import { z } from 'zod'

export const PASSWORD_KDF_MIN_ITERATIONS = 600_000
// Minimum accepted when DECRYPTING an existing value. Values wrapped under
// older, weaker KDF policies must stay readable — the vault re-encrypts them
// at PASSWORD_KDF_MIN_ITERATIONS on the next successful unlock.
export const PASSWORD_KDF_READ_MIN_ITERATIONS = 100_000
export const VAULT_PASSWORD_MAX_LENGTH = 128
// Minimum accepted when unlocking an existing vault or decrypting old data.
// Credentials created earlier under the 8-char policy must keep working.
export const VAULT_PASSWORD_MIN_LENGTH = 8
// Minimum enforced on NEW credentials (vault create / password change / PIN
// reprotect). Stronger than the legacy floor on purpose.
export const VAULT_PASSWORD_CREATE_MIN_LENGTH = 12
export const VAULT_PIN_MAX_LENGTH = 12
export const VAULT_PIN_MIN_LENGTH = 4
// New PINs are the user's choice — 4 digits minimum, gated behind an explicit
// warning at selection time. Below the recommended length the vault flags the
// credential as weak so the UI keeps nudging toward something stronger.
export const VAULT_PIN_CREATE_MIN_LENGTH = 4
export const VAULT_PIN_RECOMMENDED_MIN_LENGTH = 8
// Phrase the user must type to pick the unsecured protection mode: a typed
// confirmation is far harder to enable by accident than a checkbox.
export const VAULT_UNSECURED_CONFIRM_PHRASE = 'UNSECURED'

export const walletProtectionModeSchema = z.enum(['password', 'pin', 'unsecured'])

export const vaultCredentialPolicySchema = z
  .discriminatedUnion('mode', [
    z.object({
      maxLength: z.number().int().min(VAULT_PASSWORD_MIN_LENGTH).max(VAULT_PASSWORD_MAX_LENGTH),
      minLength: z.number().int().min(VAULT_PASSWORD_MIN_LENGTH).max(VAULT_PASSWORD_MAX_LENGTH),
      mode: z.literal('password'),
    }),
    z.object({
      maxLength: z.number().int().min(VAULT_PIN_MIN_LENGTH).max(VAULT_PIN_MAX_LENGTH),
      minLength: z.number().int().min(VAULT_PIN_MIN_LENGTH).max(VAULT_PIN_MAX_LENGTH),
      mode: z.literal('pin'),
    }),
    z.object({
      mode: z.literal('unsecured'),
    }),
  ])
  .superRefine((policy, context) => {
    if (policy.mode !== 'unsecured' && policy.minLength > policy.maxLength) {
      context.addIssue({
        code: 'custom',
        message: 'minLength must be less than or equal to maxLength',
        path: ['minLength'],
      })
    }
  })

const encryptedValueBaseSchema = z.object({
  auth_tag: z.string(),
  cipher: z.literal('aes-256-gcm'),
  cipherparams: z.object({
    iv: z.string(),
  }),
  ciphertext: z.string(),
  version: z.literal(1),
})

export const encryptedValueSchema = z.discriminatedUnion('kdf', [
  encryptedValueBaseSchema.extend({
    kdf: z.literal('direct'),
    kdfparams: z.never().optional(),
  }),
  encryptedValueBaseSchema.extend({
    kdf: z.literal('pbkdf2-sha256'),
    kdfparams: z.object({
      dklen: z.literal(32),
      hash: z.literal('sha256'),
      iterations: z.number().int().min(PASSWORD_KDF_READ_MIN_ITERATIONS),
      salt: z.string(),
    }),
  }),
])

export type EncryptedValue = z.infer<typeof encryptedValueSchema>
export type WalletProtectionMode = z.infer<typeof walletProtectionModeSchema>
