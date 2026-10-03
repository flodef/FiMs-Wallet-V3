import { useAppContext } from '@workspace/context-react/use-app-context'
import { useSetting } from '@workspace/db-react/use-setting'
import { useTranslation } from '@workspace/i18n'
import { Button } from '@workspace/ui/components/button'
import { Input } from '@workspace/ui/components/input'
import { Label } from '@workspace/ui/components/label'
import { UiLoader } from '@workspace/ui/components/ui-loader'
import { UiWarning } from '@workspace/ui/components/ui-warning'
import { decryptWithPassword, decryptWithVaultKey, encryptWithVaultKey } from '@workspace/vault/encrypted-value'
import { enrollPasskey, isPasskeyAvailable, unlockVaultWithPasskey } from '@workspace/vault-react/data-access/passkey'
import { generateTotpSecret, totpUri, verifyTotp } from '@workspace/vault-react/data-access/totp'
import { useVaultUnlockDialog } from '@workspace/vault-react/vault-unlock-provider'
import { useId, useState } from 'react'

// Optional hardening for the vault itself: a platform passkey (fingerprint /
// Windows Hello) can unlock instead of the password — the vault key material
// is wrapped under the authenticator's PRF secret — and a TOTP code adds a
// second factor on top of the password. Both are local to this device.
export function SettingsFeatureGeneralSecurity() {
  const { t } = useTranslation('settings')
  const context = useAppContext()
  const [passkey, setPasskey] = useSetting('vaultPasskey')
  const [totp, setTotp] = useSetting('vaultTotp')

  return (
    <div className="space-y-6">
      <Label>{t(($) => $.pageGeneralSecurity)}</Label>
      <PasskeySection context={context} passkey={passkey} setPasskey={setPasskey} t={t} />
      <TotpSection context={context} setTotp={setTotp} t={t} totp={totp} />
    </div>
  )
}

function PasskeySection({
  context,
  passkey,
  setPasskey,
  t,
}: {
  context: ReturnType<typeof useAppContext>
  passkey: null | string
  setPasskey: (value: string) => Promise<void>
  t: ReturnType<typeof useTranslation<'settings'>>['t']
}) {
  const passwordId = useId()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [password, setPassword] = useState('')
  const enabled = Boolean(passkey)

  async function handleEnroll() {
    setBusy(true)
    setError('')
    try {
      if (!(await isPasskeyAvailable())) {
        throw new Error('unavailable')
      }
      // Enrollment re-authenticates: the vault key material must be decrypted
      // with the real password before it can be wrapped under the PRF secret.
      const storedVaultKey = (await context.db.settings.get({ key: 'vaultKey' }))?.value
      if (!storedVaultKey) {
        throw new Error('novault')
      }
      const keyMaterial = await decryptWithPassword({ encrypted: storedVaultKey, password })
      const blob = await enrollPasskey({ keyMaterial })
      await setPasskey(blob)
      setPassword('')
    } catch (err) {
      setError(err instanceof Error && err.message === 'unavailable' ? 'unavailable' : 'failed')
    } finally {
      setBusy(false)
    }
  }

  async function handleDisable() {
    setBusy(true)
    setError('')
    try {
      // Prove possession of the enrolled passkey before removing it.
      if (passkey) {
        await unlockVaultWithPasskey(passkey)
      }
      const row = await context.db.settings.get({ key: 'vaultPasskey' })
      if (row) {
        await context.db.settings.delete(row.id)
      }
    } catch {
      setError('failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-2">
      <div className="font-medium text-sm">{t(($) => $.pageGeneralSecurityPasskey)}</div>
      <p className="text-muted-foreground text-sm">{t(($) => $.pageGeneralSecurityPasskeyHint)}</p>
      {enabled ? (
        <Button disabled={busy} onClick={() => void handleDisable()} variant="destructive">
          {busy ? <UiLoader className="size-4" /> : null}
          {t(($) => $.pageGeneralSecurityPasskeyDisable)}
        </Button>
      ) : (
        <div className="space-y-2">
          <Label htmlFor={passwordId}>{t(($) => $.pageGeneralSecurityPasswordConfirm)}</Label>
          <Input
            autoComplete="current-password"
            id={passwordId}
            onChange={(event) => setPassword(event.target.value)}
            type="password"
            value={password}
          />
          <Button disabled={busy || !password} onClick={() => void handleEnroll()}>
            {busy ? <UiLoader className="size-4" /> : null}
            {t(($) => $.pageGeneralSecurityPasskeyEnable)}
          </Button>
        </div>
      )}
      {error === 'unavailable' ? <UiWarning>{t(($) => $.pageGeneralSecurityPasskeyUnsupported)}</UiWarning> : null}
      {error === 'failed' ? <UiWarning>{t(($) => $.pageGeneralSecurityPasskeyFailed)}</UiWarning> : null}
    </div>
  )
}

function TotpSection({
  context,
  setTotp,
  t,
  totp,
}: {
  context: ReturnType<typeof useAppContext>
  setTotp: (value: string) => Promise<void>
  t: ReturnType<typeof useTranslation<'settings'>>['t']
  totp: null | string
}) {
  const codeId = useId()
  const { requestUnlock } = useVaultUnlockDialog()
  const [code, setCode] = useState('')
  const [error, setError] = useState(false)
  const [pendingSecret, setPendingSecret] = useState('')
  const enabled = Boolean(totp)

  // The secret is stored wrapped under the vault key — an IndexedDB dump
  // alone does not reveal it, so enrollment and disabling both need the
  // vault unlocked first.
  async function unlockVault(): Promise<boolean> {
    if (context.vault.isUnlocked()) {
      return true
    }
    return requestUnlock({ mode: 'password' })
  }

  async function readStoredSecret(): Promise<string> {
    if (!totp) {
      return ''
    }
    try {
      return await decryptWithVaultKey({ encrypted: totp, key: context.vault.requireDefaultKey() })
    } catch {
      // Legacy raw secret written before encryption existed.
      return totp
    }
  }

  async function handleEnable() {
    if (!(await verifyTotp({ code, secret: pendingSecret }))) {
      setError(true)
      return
    }
    if (!(await unlockVault())) {
      return
    }
    await setTotp(await encryptWithVaultKey({ key: context.vault.requireDefaultKey(), value: pendingSecret }))
    setCode('')
    setPendingSecret('')
    setError(false)
  }

  async function handleDisable() {
    if (!(await unlockVault())) {
      return
    }
    if (!(await verifyTotp({ code, secret: await readStoredSecret() }))) {
      setError(true)
      return
    }
    const row = await context.db.settings.get({ key: 'vaultTotp' })
    if (row) {
      await context.db.settings.delete(row.id)
    }
    setCode('')
    setError(false)
  }

  return (
    <div className="space-y-2">
      <div className="font-medium text-sm">{t(($) => $.pageGeneralSecurityTotp)}</div>
      <p className="text-muted-foreground text-sm">{t(($) => $.pageGeneralSecurityTotpHint)}</p>
      {pendingSecret ? (
        <div className="space-y-2">
          <p className="break-all rounded-md border bg-muted p-2 font-mono text-sm">{pendingSecret}</p>
          <p className="break-all text-muted-foreground text-xs">
            {totpUri({ account: 'vault', issuer: 'FiMs Wallet', secret: pendingSecret })}
          </p>
          <Label htmlFor={codeId}>{t(($) => $.pageGeneralSecurityTotpCode)}</Label>
          <Input
            autoComplete="one-time-code"
            id={codeId}
            inputMode="numeric"
            onChange={(event) => setCode(event.target.value)}
            value={code}
          />
          <div className="flex gap-2">
            <Button onClick={() => void handleEnable()}>{t(($) => $.pageGeneralSecurityTotpConfirm)}</Button>
            <Button onClick={() => setPendingSecret('')} variant="outline">
              {t(($) => $.pageGeneralSecurityTotpCancel)}
            </Button>
          </div>
        </div>
      ) : enabled ? (
        <div className="space-y-2">
          <Label htmlFor={codeId}>{t(($) => $.pageGeneralSecurityTotpCode)}</Label>
          <Input
            autoComplete="one-time-code"
            id={codeId}
            inputMode="numeric"
            onChange={(event) => setCode(event.target.value)}
            value={code}
          />
          <Button disabled={!code} onClick={() => void handleDisable()} variant="destructive">
            {t(($) => $.pageGeneralSecurityTotpDisable)}
          </Button>
        </div>
      ) : (
        <Button onClick={() => setPendingSecret(generateTotpSecret())} variant="secondary">
          {t(($) => $.pageGeneralSecurityTotpEnable)}
        </Button>
      )}
      {error ? <UiWarning>{t(($) => $.pageGeneralSecurityTotpInvalid)}</UiWarning> : null}
    </div>
  )
}
