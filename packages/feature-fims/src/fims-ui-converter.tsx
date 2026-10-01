import { useTranslation } from '@workspace/i18n'
import { Input } from '@workspace/ui/components/input'
import { Label } from '@workspace/ui/components/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@workspace/ui/components/select'
import { UiCard } from '@workspace/ui/components/ui-card'
import { UiLoader } from '@workspace/ui/components/ui-loader'
import { useMemo, useState } from 'react'
import { useFimsTokens } from './data-access/use-fims.tsx'
import { useFimsCurrency } from './data-access/use-fims-currency.tsx'
import { formatCurrency } from './fims-format.ts'

const tokenAmountFormatter = new Intl.NumberFormat('fr-FR', { maximumSignificantDigits: 8 })

type ConverterUnit = { eurValue: number; symbol: string }

// Display-only calculator: converts between FiMs tokens and fiat using the
// community token prices (EUR values). No transaction is created.
export function FimsUiConverter() {
  const { t } = useTranslation('fims')
  const tokens = useFimsTokens()
  const { rates } = useFimsCurrency()

  const units = useMemo<ConverterUnit[]>(
    () => [
      { eurValue: 1, symbol: 'EUR' },
      { eurValue: rates.usd > 0 ? 1 / rates.usd : 1, symbol: 'USD' },
      ...(tokens.data ?? [])
        .filter((token): token is typeof token & { value: number } => token.value != null && token.value > 0)
        .filter((token) => token.symbol !== 'EUR' && token.symbol !== 'USD')
        .map((token) => ({ eurValue: token.value, symbol: token.symbol })),
    ],
    [tokens.data, rates],
  )

  const [amountText, setAmountText] = useState('1')
  const [fromSymbol, setFromSymbol] = useState('EUR')
  const [toSymbol, setToSymbol] = useState('')

  const from = units.find((unit) => unit.symbol === fromSymbol) ?? units[0]
  const to = units.find((unit) => unit.symbol === toSymbol) ?? units.find((unit) => unit.symbol !== from?.symbol)

  const amount = Number.parseFloat(amountText.replace(',', '.'))
  const eurTotal = Number.isFinite(amount) && amount > 0 && from ? amount * from.eurValue : null

  const formattedResult =
    eurTotal == null || !to
      ? '—'
      : to.symbol === 'EUR' || to.symbol === 'SOL' || to.symbol === 'USD'
        ? formatCurrency(eurTotal, to.symbol, rates)
        : `${tokenAmountFormatter.format(eurTotal / to.eurValue)} ${to.symbol}`

  return (
    <UiCard title={t(($) => $.converterTitle)}>
      {tokens.isLoading ? (
        <UiLoader />
      ) : (
        <div className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-3">
            <div className="space-y-2">
              <Label>{t(($) => $.swapAmount)}</Label>
              <Input inputMode="decimal" onChange={(e) => setAmountText(e.target.value)} value={amountText} />
            </div>
            <div className="space-y-2">
              <Label>{t(($) => $.swapFrom)}</Label>
              <Select onValueChange={setFromSymbol} value={from?.symbol ?? ''}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {units.map((unit) => (
                    <SelectItem key={unit.symbol} value={unit.symbol}>
                      {unit.symbol}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>{t(($) => $.swapTo)}</Label>
              <Select onValueChange={setToSymbol} value={to?.symbol ?? ''}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {units.map((unit) => (
                    <SelectItem key={unit.symbol} value={unit.symbol}>
                      {unit.symbol}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <p aria-live="polite" className="text-center font-semibold text-lg">
            {amountText || '0'} {from?.symbol ?? ''} = {formattedResult}
          </p>
          <p className="text-center text-muted-foreground text-xs">{t(($) => $.converterHint)}</p>
        </div>
      )}
    </UiCard>
  )
}
