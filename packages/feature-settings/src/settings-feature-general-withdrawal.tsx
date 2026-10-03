import { solanaAddressSchema } from '@workspace/db/solana/solana-address-schema'
import { useSetting } from '@workspace/db-react/use-setting'
import {
  FIMS_JUPITER_SPEND_SYMBOLS,
  FIMS_WITHDRAWAL_PROVIDERS,
  type FimsExchangeProvider,
} from '@workspace/feature-fims/fims-constants'
import { useTranslation } from '@workspace/i18n'
import { Input } from '@workspace/ui/components/input'
import { Label } from '@workspace/ui/components/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@workspace/ui/components/select'
import { useEffect, useId, useRef, useState } from 'react'

// Off-ramp addresses the user withdraws to regularly. Saved destinations are
// offered in the send picker; sends of an asset the service does not accept
// are routed through an automatic swap into an accepted one.
export function SettingsFeatureGeneralWithdrawal() {
  const { t } = useTranslation('settings')
  const exchangeAddressId = useId()
  const exchangeProviderId = useId()
  const spendAddressId = useId()
  const [provider, setProvider] = useSetting('withdrawExchangeProvider')
  const [exchangeAddress, setExchangeAddress] = useSetting('withdrawExchangeAddress')
  const [spendAddress, setSpendAddress] = useSetting('withdrawJupiterSpend')

  const exchangeInput = useValidatedAddress(exchangeAddress, setExchangeAddress)
  const spendInput = useValidatedAddress(spendAddress, setSpendAddress)
  const selectedProvider = (provider === 'nexo' ? 'nexo' : 'coinbase') as FimsExchangeProvider
  const accepted = FIMS_WITHDRAWAL_PROVIDERS[selectedProvider].acceptedSymbols.join(', ')

  return (
    <div className="space-y-4">
      <Label>{t(($) => $.pageGeneralWithdrawal)}</Label>
      <div className="space-y-2">
        <Label htmlFor={exchangeProviderId}>{t(($) => $.pageGeneralWithdrawalExchangeProvider)}</Label>
        <Select onValueChange={(value) => void setProvider(value)} value={selectedProvider}>
          <SelectTrigger id={exchangeProviderId}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="coinbase">Coinbase</SelectItem>
            <SelectItem value="nexo">Nexo</SelectItem>
          </SelectContent>
        </Select>
        <Input
          className={exchangeInput.invalid ? 'border-destructive' : undefined}
          id={exchangeAddressId}
          onChange={(event) => exchangeInput.onChange(event.target.value)}
          placeholder={t(($) => $.pageGeneralWithdrawalExchangeAddress)}
          spellCheck={false}
          value={exchangeInput.value}
        />
        {exchangeInput.invalid ? (
          <p className="text-destructive text-sm">{t(($) => $.pageGeneralWithdrawalInvalid)}</p>
        ) : (
          <p className="text-muted-foreground text-sm">{t(($) => $.pageGeneralWithdrawalExchangeHint, { accepted })}</p>
        )}
      </div>
      <div className="space-y-2">
        <Label htmlFor={spendAddressId}>{t(($) => $.pageGeneralWithdrawalSpend)}</Label>
        <Input
          className={spendInput.invalid ? 'border-destructive' : undefined}
          id={spendAddressId}
          onChange={(event) => spendInput.onChange(event.target.value)}
          placeholder={t(($) => $.pageGeneralWithdrawalSpendAddress)}
          spellCheck={false}
          value={spendInput.value}
        />
        {spendInput.invalid ? (
          <p className="text-destructive text-sm">{t(($) => $.pageGeneralWithdrawalInvalid)}</p>
        ) : (
          <p className="text-muted-foreground text-sm">
            {t(($) => $.pageGeneralWithdrawalSpendHint, { accepted: FIMS_JUPITER_SPEND_SYMBOLS.join(', ') })}
          </p>
        )}
      </div>
    </div>
  )
}

// Field state mirrors the stored setting once it resolves; the setting only
// ever stores a valid address or empty — an incomplete/invalid address is
// flagged in the UI and saved as cleared, never as garbage.
function useValidatedAddress(stored: string | null | undefined, setStored: (value: string) => unknown) {
  const [value, setValue] = useState(stored ?? '')
  const initialized = useRef(false)

  useEffect(() => {
    if (!initialized.current && stored != null) {
      initialized.current = true
      setValue(stored)
    }
  }, [stored])

  const invalid = value.trim().length > 0 && !solanaAddressSchema.safeParse(value.trim()).success

  return {
    invalid,
    onChange: (next: string) => {
      setValue(next)
      const trimmed = next.trim()
      void setStored(solanaAddressSchema.safeParse(trimmed).success ? trimmed : '')
    },
    value,
  }
}
