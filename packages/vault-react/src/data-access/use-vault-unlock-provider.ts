import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useAppContext } from '@workspace/context-react/use-app-context'
import { decryptWithVaultKey } from '@workspace/vault/encrypted-value'
import { useCallback, useMemo, useRef, useState } from 'react'
import { optionsVault, vaultStatusQueryKey } from './options-vault.ts'
import { hasPasskey, unlockVaultWithPasskey } from './passkey.ts'
import { verifyTotp } from './totp.ts'
import type { VaultUnlockDialogContext, VaultUnlockRequest } from './use-vault-unlock-dialog.ts'
import { useVaultUnlockDialogCopy } from './use-vault-unlock-dialog-copy.ts'
import { submitVaultPassword } from './vault-password-submit.ts'

export interface VaultUnlockDialogActions {
  cancel(): void
  changeConfirmPassword(value: string): void
  changeCredential(value: string): void
  changeOpen(open: boolean): void
  changeTotp(value: string): void
  submit(): void
  submitPasskey(): void
}

export interface VaultUnlockDialogState {
  cancelLabel: string
  confirmPassword: string
  confirmPasswordLabel: string
  credential: string
  credentialInputType: 'password' | 'text'
  credentialLabel: string
  description: string
  error: string | null
  hasPasskey: boolean
  isOpen: boolean
  isSetupMode: boolean
  isSubmitting: boolean
  isTotpStep: boolean
  passkeyLabel: string
  submitLabel: string
  title: string
  totp: string
  totpLabel: string
}

export interface VaultUnlockProviderValue {
  actions: VaultUnlockDialogActions
  contextValue: VaultUnlockDialogContext
  state: VaultUnlockDialogState
}

type PendingVaultUnlockRequest = Required<Pick<VaultUnlockRequest, 'mode'>> &
  Omit<VaultUnlockRequest, 'mode'> & {
    resolve: (value: boolean) => void
  }

type VaultUnlockSubmitInput = {
  confirmPassword: string
  credential: string
  pending: PendingVaultUnlockRequest
  setupMode: boolean
}

export function useVaultUnlockProvider(): VaultUnlockProviderValue {
  const context = useAppContext()
  const copy = useVaultUnlockDialogCopy()
  const pendingRef = useRef<PendingVaultUnlockRequest | null>(null)
  // Set when this request already unlocked key material, so a cancel during
  // the TOTP step can roll the unlock back instead of leaving keys cached.
  const rollbackUnlockRef = useRef<null | (() => void)>(null)
  const queryClient = useQueryClient()
  const [confirmPassword, setConfirmPassword] = useState('')
  const [credential, setCredential] = useState('')
  const [hasPasskeyState, setHasPasskeyState] = useState(false)
  const [isTotpStep, setIsTotpStep] = useState(false)
  const [pending, setPending] = useState<PendingVaultUnlockRequest | null>(null)
  const [setupMode, setSetupMode] = useState(false)
  const [totp, setTotp] = useState('')
  const [totpError, setTotpError] = useState(false)
  const [totpSecret, setTotpSecret] = useState<string | null>(null)
  const {
    error: unlockError,
    isPending: isSubmitting,
    mutate: submitUnlock,
    reset: resetSubmitUnlock,
  } = useMutation({
    mutationFn: async ({ confirmPassword, credential, pending, setupMode }: VaultUnlockSubmitInput) => {
      if (setupMode || pending.mode === 'password') {
        await submitVaultPassword(context.vault, {
          confirmPassword: setupMode ? confirmPassword : undefined,
          password: credential,
        })
        rollbackUnlockRef.current = () => context.vault.lock()
      } else {
        if (!pending.walletId) {
          throw new Error('Wallet id is required')
        }
        const walletId = pending.walletId
        await context.vault.unlockWallet({ credential, walletId })
        rollbackUnlockRef.current = () => context.vault.clearWalletKey({ walletId })
      }
      await queryClient.invalidateQueries({ queryKey: vaultStatusQueryKey })
    },
  })

  const resetForm = useCallback(() => {
    setConfirmPassword('')
    setCredential('')
    setIsTotpStep(false)
    setTotp('')
    setTotpError(false)
    setTotpSecret(null)
    resetSubmitUnlock()
    setSetupMode(false)
  }, [resetSubmitUnlock])

  const close = useCallback(
    (value: boolean) => {
      if (!value) {
        rollbackUnlockRef.current?.()
      }
      rollbackUnlockRef.current = null
      const request = pendingRef.current
      pendingRef.current = null
      setPending(null)
      resetForm()
      request?.resolve(value)
    },
    [resetForm],
  )

  const resetSubmitError = useCallback(() => {
    if (!isSubmitting) {
      resetSubmitUnlock()
    }
  }, [isSubmitting, resetSubmitUnlock])

  const changeConfirmPassword = useCallback(
    (value: string) => {
      setConfirmPassword(value)
      resetSubmitError()
    },
    [resetSubmitError],
  )

  const changeCredential = useCallback(
    (value: string) => {
      setCredential(value)
      resetSubmitError()
    },
    [resetSubmitError],
  )

  const changeOpen = useCallback(
    (open: boolean) => {
      if (!open) {
        close(false)
      }
    },
    [close],
  )

  const requestUnlock = useCallback(
    async (input: VaultUnlockRequest = {}): Promise<boolean> => {
      const mode = input.mode ?? 'password'

      if (mode === 'unsecured') {
        if (!input.walletId) {
          return true
        }
        try {
          await context.vault.unlockWallet({ credential: '', walletId: input.walletId })
          return true
        } catch {
          return false
        }
      }

      if (input.walletId) {
        try {
          await context.vault.requireWalletKey({ walletId: input.walletId })
          return true
        } catch {
          // Continue into the dialog.
        }
      } else if (mode === 'password' && context.vault.isUnlocked()) {
        return true
      }

      // requestUnlock is single-flight: pendingRef.current means another dialog is already open, so
      // return false to mark this request as ignored rather than queueing subsequent requests.
      if (pendingRef.current) {
        return false
      }

      const request: PendingVaultUnlockRequest = {
        ...input,
        mode,
        resolve: () => undefined,
      }
      const promise = new Promise<boolean>((resolve) => {
        request.resolve = resolve
      })

      pendingRef.current = request

      try {
        const status = await queryClient.fetchQuery(optionsVault.status(context))
        setSetupMode(!status.isConfigured)
        setPending(request)
        const stored = await context.db.settings.get({ key: 'vaultPasskey' })
        setHasPasskeyState(hasPasskey(stored?.value))
      } catch (error) {
        pendingRef.current = null
        setPending(null)
        request.resolve(false)
        throw error
      }

      return promise
    },
    [context, queryClient],
  )

  // After a credential unlock succeeds, an enrolled TOTP secret demands a
  // second step: the dialog stays open on the code input until verifyTotp
  // accepts — or the user cancels, which resolves the request as failed and
  // rolls the unlock back via close(false).
  const completeUnlock = useCallback(async () => {
    const totpSetting = (await context.db.settings.get({ key: 'vaultTotp' }))?.value
    if (totpSetting && context.vault.isUnlocked()) {
      // The secret is wrapped under the vault key so an IndexedDB dump alone
      // does not reveal it; fall back to the raw value for blobs written by
      // development builds before encryption existed.
      let secret = totpSetting
      try {
        secret = await decryptWithVaultKey({ encrypted: totpSetting, key: context.vault.requireDefaultKey() })
      } catch {
        // Not an EncryptedValue — treat as a legacy raw secret.
      }
      setTotpSecret(secret)
      setIsTotpStep(true)
      return
    }
    close(true)
  }, [close, context.db.settings, context.vault])

  const submit = useCallback(() => {
    if (!pending || isSubmitting) {
      return
    }

    if (isTotpStep) {
      const secret = totpSecret
      if (!secret) {
        return
      }
      void verifyTotp({ code: totp, secret }).then((valid) => {
        if (valid) {
          close(true)
        } else {
          setTotp('')
          setTotpError(true)
        }
      })
      return
    }

    submitUnlock(
      { confirmPassword, credential, pending, setupMode },
      {
        onSuccess: () => void completeUnlock(),
      },
    )
  }, [
    close,
    completeUnlock,
    confirmPassword,
    credential,
    isSubmitting,
    isTotpStep,
    pending,
    setupMode,
    submitUnlock,
    totp,
    totpSecret,
  ])

  const submitPasskey = useCallback(() => {
    if (!pending || isSubmitting) {
      return
    }
    void (async () => {
      try {
        const stored = (await context.db.settings.get({ key: 'vaultPasskey' }))?.value
        if (!stored) {
          throw new Error('No passkey enrolled')
        }
        const keyMaterial = await unlockVaultWithPasskey(stored)
        await context.vault.unlockWithKeyMaterial({ keyMaterial })
        rollbackUnlockRef.current = () => context.vault.lock()
        await queryClient.invalidateQueries({ queryKey: vaultStatusQueryKey })
        await completeUnlock()
      } catch {
        close(false)
      }
    })()
  }, [close, completeUnlock, context, isSubmitting, pending, queryClient])

  const changeTotp = useCallback((value: string) => {
    setTotp(value.replace(/[^\d]/g, '').slice(0, 6))
    setTotpError(false)
  }, [])

  const contextValue = useMemo<VaultUnlockDialogContext>(() => ({ requestUnlock }), [requestUnlock])
  const error = totpError
    ? copy.totpInvalid
    : unlockError
      ? unlockError instanceof Error
        ? unlockError.message
        : 'Unable to unlock'
      : null

  return {
    actions: {
      cancel: () => close(false),
      changeConfirmPassword,
      changeCredential,
      changeOpen,
      changeTotp,
      submit,
      submitPasskey,
    },
    contextValue,
    state: {
      cancelLabel: copy.actionCancel,
      confirmPassword,
      confirmPasswordLabel: copy.confirmPasswordLabel,
      credential,
      credentialInputType: pending?.mode === 'pin' ? 'text' : 'password',
      credentialLabel: pending?.mode === 'pin' ? copy.pinLabel : copy.passwordLabel,
      description: setupMode ? copy.setupDescription : (pending?.description ?? copy.defaultDescription),
      error,
      hasPasskey: hasPasskeyState && pending?.mode === 'password' && !setupMode,
      isOpen: Boolean(pending),
      isSetupMode: setupMode,
      isSubmitting,
      isTotpStep,
      passkeyLabel: copy.passkeyLabel,
      submitLabel: copy.actionContinue,
      title: setupMode ? copy.setupTitle : (pending?.title ?? copy.defaultTitle),
      totp,
      totpLabel: copy.totpLabel,
    },
  }
}
