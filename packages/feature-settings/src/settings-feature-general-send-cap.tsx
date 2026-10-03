import { useAccountActive } from '@workspace/db-react/use-account-active'
import { useSetting } from '@workspace/db-react/use-setting'
import { useWalletFindUnique } from '@workspace/db-react/use-wallet-find-unique'
import { useTranslation } from '@workspace/i18n'
import { Input } from '@workspace/ui/components/input'
import { Label } from '@workspace/ui/components/label'
import { useVaultUnlockDialog } from '@workspace/vault-react/vault-unlock-provider'
import { useEffect, useId, useRef, useState } from 'react'

// Optional EUR ceiling applied to outgoing transfers (client-side guard).
export function SettingsFeatureGeneralSendCap() {
  const { t } = useTranslation('settings')
  const sendCapId = useId()
  const [sendCap, setSendCap] = useSetting('sendCapEur')
  const [input, setInput] = useState('')
  const initialized = useRef(false)
  const account = useAccountActive()
  const wallet = useWalletFindUnique({ id: account.walletId })
  const { requestUnlock } = useVaultUnlockDialog()

  // Hydrate the input once when the stored value first resolves; afterwards the
  // field is owned by the user so typing decimals is not reformatted mid-edit.
  useEffect(() => {
    if (!initialized.current && sendCap) {
      initialized.current = true
      setInput(sendCap)
    }
  }, [sendCap])

  async function handleChange(value: string) {
    setInput(value)
    const parsed = Number.parseFloat(value)
    const next = !value.trim().length || !Number.isFinite(parsed) || parsed <= 0 ? 0 : parsed
    const previous = Number.parseFloat(sendCap ?? '')
    // Raising or clearing the cap widens the theft window — re-authenticate
    // first, so a hijacked unlocked session cannot silently lift the guard.
    const weakens = previous > 0 && (next === 0 || next > previous)
    if (weakens && wallet) {
      const unlocked = await requestUnlock({
        mode: wallet.protectionMode,
        reason: 'generic',
        walletId: wallet.id,
      })
      if (!unlocked) {
        setInput(sendCap ?? '')
        return
      }
    }
    void setSendCap(next > 0 ? `${next}` : '')
  }

  return (
    <div className="space-y-2">
      <Label htmlFor={sendCapId}>{t(($) => $.pageGeneralSendCap)}</Label>
      <Input
        id={sendCapId}
        inputMode="decimal"
        min="0"
        onChange={(event) => void handleChange(event.target.value)}
        placeholder={t(($) => $.pageGeneralSendCapPlaceholder)}
        type="number"
        value={input}
      />
      <p className="text-muted-foreground text-sm">{t(($) => $.pageGeneralSendCapHint)}</p>
    </div>
  )
}
