import { envAllowUnsecuredWallets } from '@workspace/env/env'
import { useTranslation } from '@workspace/i18n'
import { Alert, AlertDescription } from '@workspace/ui/components/alert'
import { Input } from '@workspace/ui/components/input'
import { Label } from '@workspace/ui/components/label'
import { ToggleGroup, ToggleGroupItem } from '@workspace/ui/components/toggle-group'
import {
  VAULT_PIN_CREATE_MIN_LENGTH,
  VAULT_PIN_MAX_LENGTH,
  VAULT_UNSECURED_CONFIRM_PHRASE,
} from '@workspace/vault/encrypted-value-schema'
import { useId } from 'react'
import type { CreateNewWalletProtectionMode } from '../data-access/use-create-new-wallet.tsx'

export function OnboardingUiWalletProtection({
  onPinChange,
  onPinConfirmChange,
  onProtectionModeChange,
  onUnsecuredConfirmTextChange,
  pin,
  pinConfirm,
  protectionMode,
  unsecuredConfirmText,
}: {
  onPinChange: (value: string) => void
  onPinConfirmChange: (value: string) => void
  onProtectionModeChange: (value: string) => void
  onUnsecuredConfirmTextChange: (value: string) => void
  pin: string
  pinConfirm: string
  protectionMode: CreateNewWalletProtectionMode
  unsecuredConfirmText: string
}) {
  const { t } = useTranslation('onboarding')
  const pinConfirmId = useId()
  const pinId = useId()
  const protectionId = useId()
  const unsecuredConfirmId = useId()
  // Cleartext storage only ever appears when the build opts in
  // (VITE_ALLOW_UNSECURED_WALLETS) — production users never see it.
  const allowUnsecured = envAllowUnsecuredWallets()

  return (
    <details className="space-y-4">
      <summary className="cursor-pointer text-muted-foreground text-sm">{t(($) => $.walletProtectionTitle)}</summary>
      <div className="space-y-4 pt-2">
        <ToggleGroup
          aria-label={t(($) => $.walletProtectionTitle)}
          className={`grid w-full grid-cols-1 ${allowUnsecured ? 'sm:grid-cols-3' : 'sm:grid-cols-2'}`}
          id={protectionId}
          onValueChange={onProtectionModeChange}
          type="single"
          value={protectionMode}
          variant="outline"
        >
          <ToggleGroupItem
            className="h-auto min-h-9 whitespace-normal px-3 py-2 text-center leading-snug"
            value="password"
          >
            {t(($) => $.walletProtectionPassword)}
          </ToggleGroupItem>
          <ToggleGroupItem className="h-auto min-h-9 whitespace-normal px-3 py-2 text-center leading-snug" value="pin">
            {t(($) => $.walletProtectionPin)}
          </ToggleGroupItem>
          {allowUnsecured ? (
            <ToggleGroupItem
              className="h-auto min-h-9 whitespace-normal px-3 py-2 text-center leading-snug"
              value="unsecured"
            >
              {t(($) => $.walletProtectionUnsecured)}
            </ToggleGroupItem>
          ) : null}
        </ToggleGroup>
        {protectionMode === 'pin' ? (
          <div className="space-y-3">
            <Alert variant="warning">
              <AlertDescription>{t(($) => $.walletProtectionPinWarning)}</AlertDescription>
            </Alert>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor={pinId}>{t(($) => $.walletProtectionPinLabel)}</Label>
                <Input
                  autoComplete="off"
                  id={pinId}
                  inputMode="numeric"
                  maxLength={VAULT_PIN_MAX_LENGTH}
                  minLength={VAULT_PIN_CREATE_MIN_LENGTH}
                  onChange={(event) => onPinChange(event.target.value)}
                  pattern="[0-9]*"
                  type="password"
                  value={pin}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor={pinConfirmId}>{t(($) => $.walletProtectionPinConfirmLabel)}</Label>
                <Input
                  autoComplete="off"
                  id={pinConfirmId}
                  inputMode="numeric"
                  maxLength={VAULT_PIN_MAX_LENGTH}
                  minLength={VAULT_PIN_CREATE_MIN_LENGTH}
                  onChange={(event) => onPinConfirmChange(event.target.value)}
                  pattern="[0-9]*"
                  type="password"
                  value={pinConfirm}
                />
              </div>
            </div>
          </div>
        ) : null}
        {allowUnsecured && protectionMode === 'unsecured' ? (
          <div className="space-y-3">
            <Alert variant="warning">
              <AlertDescription>{t(($) => $.walletProtectionUnsecuredWarning)}</AlertDescription>
            </Alert>
            <div className="space-y-2">
              <Label htmlFor={unsecuredConfirmId}>
                {t(($) => $.walletProtectionUnsecuredConfirm, { phrase: VAULT_UNSECURED_CONFIRM_PHRASE })}
              </Label>
              <Input
                autoComplete="off"
                id={unsecuredConfirmId}
                onChange={(event) => onUnsecuredConfirmTextChange(event.target.value)}
                value={unsecuredConfirmText}
              />
            </div>
          </div>
        ) : null}
      </div>
    </details>
  )
}
