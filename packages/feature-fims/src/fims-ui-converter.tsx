import { useTranslation } from '@workspace/i18n'
import { formatNumber } from '@workspace/i18n/format'
import type { TokenMetadata } from '@workspace/solana-client/get-token-metadata-jupiter'
import { Button } from '@workspace/ui/components/button'
import { UiCard } from '@workspace/ui/components/ui-card'
import { UiIcon } from '@workspace/ui/components/ui-icon'
import { UiLoader } from '@workspace/ui/components/ui-loader'
import { useMemo, useState } from 'react'
import { useFimsTokens } from './data-access/use-fims.tsx'
import { useFimsCurrency } from './data-access/use-fims-currency.tsx'
import { FimsUiTokenAmountInput } from './fims-ui-token-amount-input.tsx'

type ConverterUnit = { address?: null | string; eurValue: number; symbol: string }

// Display-only calculator on the Exchange page: converts between FiMs tokens
// and fiat using the community token prices (EUR values). The reverse button
// swaps the units and keeps the amount — 1 EUR→USD becomes 1 USD→EUR.
export function FimsUiConverter({ metaByMint }: { metaByMint: Map<string, TokenMetadata> }) {
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
        .map((token) => ({ address: token.address, eurValue: token.value, symbol: token.symbol })),
    ],
    [tokens.data, rates],
  )
  const options = useMemo(
    () =>
      units.map((unit) => ({
        icon: unit.address ? (metaByMint.get(unit.address)?.icon ?? null) : null,
        symbol: unit.symbol,
        value: unit.symbol,
      })),
    [units, metaByMint],
  )

  const [amountText, setAmountText] = useState('1')
  const [fromSymbol, setFromSymbol] = useState('EUR')
  const [toSymbol, setToSymbol] = useState('USD')

  const from = units.find((unit) => unit.symbol === fromSymbol) ?? units[0]
  const to = units.find((unit) => unit.symbol === toSymbol) ?? units.find((unit) => unit.symbol !== from?.symbol)

  const amount = Number.parseFloat(amountText.replace(',', '.'))
  const eurTotal = Number.isFinite(amount) && amount > 0 && from ? amount * from.eurValue : null
  const result = eurTotal == null || !to ? '' : formatNumber(eurTotal / to.eurValue, { maximumSignificantDigits: 8 })

  const canReverse = Boolean(from?.symbol && to?.symbol)
  const handleReverse = () => {
    if (!from || !to) return
    setFromSymbol(to.symbol)
    setToSymbol(from.symbol)
  }

  return (
    <UiCard title={t(($) => $.converterTitle)}>
      {tokens.isLoading ? (
        <UiLoader />
      ) : (
        <div className="space-y-4">
          <div className="space-y-1">
            <FimsUiTokenAmountInput
              amount={amountText}
              label={t(($) => $.swapFrom)}
              onAmountChange={setAmountText}
              onTokenChange={setFromSymbol}
              options={options}
              tokenValue={from?.symbol ?? ''}
            />
            <div className="flex justify-center">
              <Button
                aria-label={t(($) => $.swapReverse)}
                className="rounded-full"
                disabled={!canReverse}
                onClick={handleReverse}
                size="icon"
                variant="outline"
              >
                <UiIcon className="size-4" icon="arrowDown" />
              </Button>
            </div>
            <FimsUiTokenAmountInput
              amount={result}
              label={t(($) => $.swapTo)}
              onTokenChange={setToSymbol}
              options={options}
              readOnly
              tokenValue={to?.symbol ?? ''}
            />
          </div>
          <p className="text-center text-muted-foreground text-xs">{t(($) => $.converterHint)}</p>
        </div>
      )}
    </UiCard>
  )
}
