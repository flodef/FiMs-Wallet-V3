import { useTranslation } from '@workspace/i18n'

export function useVaultUnlockDialogCopy() {
  const { t } = useTranslation('vault-react')

  return {
    actionCancel: t(($) => $.unlockDialogActionCancel),
    actionContinue: t(($) => $.unlockDialogActionContinue),
    confirmPasswordLabel: t(($) => $.unlockDialogConfirmPasswordLabel),
    defaultDescription: t(($) => $.unlockDialogDefaultDescription),
    defaultTitle: t(($) => $.unlockDialogDefaultTitle),
    passkeyLabel: t(($) => $.unlockDialogPasskeyLabel),
    passwordLabel: t(($) => $.unlockDialogPasswordLabel),
    pinLabel: t(($) => $.unlockDialogPinLabel),
    setupDescription: t(($) => $.unlockDialogSetupDescription),
    setupTitle: t(($) => $.unlockDialogSetupTitle),
    totpInvalid: t(($) => $.unlockDialogTotpInvalid),
    totpLabel: t(($) => $.unlockDialogTotpLabel),
    weakPasswordWarning: t(($) => $.unlockWeakPasswordWarning),
    weakPinWarning: t(($) => $.unlockWeakPinWarning),
  }
}
