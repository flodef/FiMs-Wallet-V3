import { useSetting } from '@workspace/db-react/use-setting'
import { useMemo } from 'react'
import { DEFAULT_RATES, type FimsCurrency, type FimsCurrencyRates, formatCurrency } from '../fims-format.ts'
import { useFimsTokens } from './use-fims.tsx'

// Token `value` is the EUR price of 1 unit → 1 EUR = 1/value units.
export function useFimsCurrency() {
  const [stored, setStored] = useSetting('fimsCurrency')
  const tokens = useFimsTokens()

  const currency: FimsCurrency = stored === 'SOL' || stored === 'USD' ? stored : 'EUR'

  const rates = useMemo<FimsCurrencyRates>(() => {
    const list = tokens.data ?? []
    const usd = list.find((token) => token.symbol === 'USDC')?.value
    const sol = list.find((token) => token.symbol === 'SOL')?.value
    return { sol: sol ? 1 / sol : DEFAULT_RATES.sol, usd: usd ? 1 / usd : DEFAULT_RATES.usd }
  }, [tokens.data])

  const format = useMemo(() => (value: number) => formatCurrency(value, currency, rates), [currency, rates])

  return { currency, format, rates, setCurrency: setStored }
}
