import { useSetting } from '@workspace/db-react/use-setting'
import { useTranslation } from '@workspace/i18n'
import { Input } from '@workspace/ui/components/input'
import { Label } from '@workspace/ui/components/label'
import { useEffect, useId, useRef, useState } from 'react'

// Optional EUR ceiling applied to outgoing transfers (client-side guard).
export function SettingsFeatureGeneralSendCap() {
  const { t } = useTranslation('settings')
  const sendCapId = useId()
  const [sendCap, setSendCap] = useSetting('sendCapEur')
  const [input, setInput] = useState('')
  const initialized = useRef(false)

  // Hydrate the input once when the stored value first resolves; afterwards the
  // field is owned by the user so typing decimals is not reformatted mid-edit.
  useEffect(() => {
    if (!initialized.current && sendCap) {
      initialized.current = true
      setInput(sendCap)
    }
  }, [sendCap])

  function handleChange(value: string) {
    setInput(value)
    const parsed = Number.parseFloat(value)
    if (!value.trim().length || !Number.isFinite(parsed) || parsed <= 0) {
      void setSendCap('')
      return
    }
    void setSendCap(`${parsed}`)
  }

  return (
    <div className="space-y-2">
      <Label htmlFor={sendCapId}>{t(($) => $.pageGeneralSendCap)}</Label>
      <Input
        id={sendCapId}
        inputMode="decimal"
        min="0"
        onChange={(event) => handleChange(event.target.value)}
        placeholder={t(($) => $.pageGeneralSendCapPlaceholder)}
        type="number"
        value={input}
      />
      <p className="text-muted-foreground text-sm">{t(($) => $.pageGeneralSendCapHint)}</p>
    </div>
  )
}
