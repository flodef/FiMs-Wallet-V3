import { useSetting } from '@workspace/db-react/use-setting'
import { useMemo } from 'react'
import { type FimsCurrency, formatCurrency } from '../fims-format.ts'
import { useFimsTokens } from './use-fims.tsx'

export function useFimsCurrency() {
  const [stored, setStored] = useSetting('fimsCurrency')
  const tokens = useFimsTokens()

  const currency: FimsCurrency = stored === 'USD' ? 'USD' : 'EUR'

  // 1 stablecoin is `value` EUR → 1 EUR = 1/value USD
  const eurUsdRate = useMemo(() => {
    const stable = (tokens.data ?? []).find((token) => token.symbol === 'USDC')
    return stable?.value ? 1 / stable.value : 1
  }, [tokens.data])

  const format = useMemo(() => (value: number) => formatCurrency(value, currency, eurUsdRate), [currency, eurUsdRate])

  return { currency, eurUsdRate, format, setCurrency: setStored }
}
