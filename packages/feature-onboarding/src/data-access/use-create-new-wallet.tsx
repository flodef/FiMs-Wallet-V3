import { assertIsAddress } from '@solana/kit'
import { useAppContext } from '@workspace/context-react/use-app-context'
import { walletTransferDecode } from '@workspace/db/wallet/wallet-transfer'
import { useAccountCreate } from '@workspace/db-react/use-account-create'
import { useWalletCreate } from '@workspace/db-react/use-wallet-create'
import { useWalletDetermineName } from '@workspace/db-react/use-wallet-determine-name'
import { useWalletGenerateWithAccount } from '@workspace/db-react/use-wallet-generate-with-account'
import { envAllowUnsecuredWallets } from '@workspace/env/env'
import { derivationPaths } from '@workspace/keypair/derivation-paths'
import { importKeyPairToPublicKeySecretKey } from '@workspace/keypair/import-key-pair-to-public-key-secret-key'
import { ellipsify } from '@workspace/ui/lib/ellipsify'
import { toastError } from '@workspace/ui/lib/toast-error'
import { toastSuccess } from '@workspace/ui/lib/toast-success'
import {
  VAULT_PIN_CREATE_MIN_LENGTH,
  VAULT_PIN_MAX_LENGTH,
  VAULT_UNSECURED_CONFIRM_PHRASE,
} from '@workspace/vault/encrypted-value-schema'
import { useVaultUnlockDialog } from '@workspace/vault-react/vault-unlock-provider'

export type CreateNewWalletProtection = { mode: 'password' } | { mode: 'pin'; pin: string } | { mode: 'unsecured' }

export type CreateNewWalletProtectionMode = CreateNewWalletProtection['mode']

export function useCreateNewWallet() {
  const mutation = useWalletGenerateWithAccount()
  const name = useWalletDetermineName()
  const { requestUnlock } = useVaultUnlockDialog()

  return async (mnemonic: string, input?: CreateNewWalletProtection): Promise<boolean> => {
    const protection = input ?? { mode: 'password' }
    if (protection.mode === 'password') {
      const unlocked = await requestUnlock({ mode: 'password', reason: 'createWallet' })
      if (!unlocked) {
        return false
      }
    }

    return mutation
      .mutateAsync({
        derivationPath: derivationPaths.default,
        mnemonic,
        name,
        protection,
      })
      .then(() => {
        toastSuccess('Wallet created!')
        return true
      })
      .catch((error) => {
        toastError(`${error}`)
        return false
      })
  }
}

export function useCreateNewWalletFromPrivateKey() {
  const context = useAppContext()
  const createAccountMutation = useAccountCreate()
  const createWalletMutation = useWalletCreate()
  const name = useWalletDetermineName()
  const { requestUnlock } = useVaultUnlockDialog()

  return async (privateKey: string, input?: CreateNewWalletProtection): Promise<boolean> => {
    const protection = input ?? { mode: 'password' }
    try {
      const { publicKey, secretKey } = await importKeyPairToPublicKeySecretKey(privateKey, true)
      assertIsAddress(publicKey)

      if (protection.mode === 'password') {
        const unlocked = await requestUnlock({ mode: 'password', reason: 'createWallet' })
        if (!unlocked) {
          return false
        }
      }

      const walletId = await createWalletMutation.mutateAsync({
        input: { derivationPath: '', mnemonic: '', name, protection },
      })
      if (protection.mode === 'pin') {
        await context.vault.unlockWallet({ credential: protection.pin, walletId })
      }
      await createAccountMutation.mutateAsync({
        input: { name: ellipsify(publicKey), publicKey, secretKey, type: 'Imported', walletId },
      })
      toastSuccess('Wallet created!')
      return true
    } catch (error) {
      toastError(`${error}`)
      return false
    }
  }
}

export function getCreateNewWalletProtection(input: {
  pin: string
  pinConfirm: string
  protectionMode: CreateNewWalletProtectionMode
  unsecuredConfirmText: string
}): CreateNewWalletProtection {
  switch (input.protectionMode) {
    case 'password':
      return { mode: 'password' }
    case 'pin':
      if (!new RegExp(`^\\d{${VAULT_PIN_CREATE_MIN_LENGTH},${VAULT_PIN_MAX_LENGTH}}$`).test(input.pin)) {
        throw new Error(`PIN must be ${VAULT_PIN_CREATE_MIN_LENGTH}-${VAULT_PIN_MAX_LENGTH} digits`)
      }
      if (input.pin !== input.pinConfirm) {
        throw new Error('PINs do not match')
      }
      return { mode: 'pin', pin: input.pin }
    case 'unsecured':
      // Cleartext storage is a dev/test escape hatch (VITE_ALLOW_UNSECURED_WALLETS).
      if (!envAllowUnsecuredWallets()) {
        throw new Error('Unsecured wallet protection is not available')
      }
      if (input.unsecuredConfirmText !== VAULT_UNSECURED_CONFIRM_PHRASE) {
        throw new Error(`Type ${VAULT_UNSECURED_CONFIRM_PHRASE} to confirm this wallet is not protected`)
      }
      return { mode: 'unsecured' }
  }
}

export function parseCreateNewWalletProtectionMode(value: string): CreateNewWalletProtectionMode {
  switch (value) {
    case 'pin':
    case 'unsecured':
      return value
    default:
      return 'password'
  }
}

// Device-to-device transfer (Jupiter Sync style): the source device shows a
// QR code carrying the wallet secrets, the target decodes it and recreates
// the wallet with a protection chosen locally. Nothing goes through a server.
export function useImportWalletTransfer() {
  const context = useAppContext()
  const createAccountMutation = useAccountCreate()
  const createWalletMutation = useWalletCreate()
  const { requestUnlock } = useVaultUnlockDialog()

  return async (code: string, input?: CreateNewWalletProtection): Promise<boolean> => {
    const protection = input ?? { mode: 'password' }
    try {
      const payload = walletTransferDecode(code)
      if (protection.mode === 'password') {
        const unlocked = await requestUnlock({ mode: 'password', reason: 'createWallet' })
        if (!unlocked) {
          return false
        }
      }

      const walletId = await createWalletMutation.mutateAsync({
        input: { derivationPath: payload.derivationPath, mnemonic: payload.mnemonic, name: payload.name, protection },
      })
      if (protection.mode === 'pin') {
        await context.vault.unlockWallet({ credential: protection.pin, walletId })
      }
      for (const account of payload.accounts) {
        await createAccountMutation.mutateAsync({
          input: {
            derivationIndex: account.derivationIndex,
            name: account.name,
            publicKey: account.publicKey,
            secretKey: account.secretKey,
            type: account.type,
            walletId,
          },
        })
      }
      toastSuccess('Wallet imported!')
      return true
    } catch (error) {
      toastError(`${error}`)
      return false
    }
  }
}
