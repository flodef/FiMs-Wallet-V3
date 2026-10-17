import {
  type PortfolioPricing,
  PortfolioPricingContext,
} from '@workspace/feature-portfolio/data-access/portfolio-pricing'
import { type ReactNode, useMemo } from 'react'
import { useFimsTokens } from './data-access/use-fims.tsx'
import { useFimsCurrency } from './data-access/use-fims-currency.tsx'

// Feeds the portfolio with the protocol's own prices (the `tokens` table,
// EUR per unit) and the user's display currency: FiMs, FLiP and FiMsSOL have
// no Jupiter price, so without this they would count for zero.
export function FimsPortfolioPricingProvider({ children }: { children: ReactNode }) {
  const tokens = useFimsTokens()
  const { format, rates } = useFimsCurrency()

  const pricing = useMemo<PortfolioPricing>(() => {
    const priced = (tokens.data ?? []).flatMap((token) =>
      token.address && token.value !== null && token.value > 0
        ? [{ ...token, address: token.address, value: token.value }]
        : [],
    )
    return {
      format,
      metadata: new Map(
        priced.map((token) => [
          token.address,
          { decimals: 0, icon: '', id: token.address, name: token.label, symbol: token.symbol, usdPrice: 0 },
        ]),
      ),
      pricesEur: new Map(priced.map((token) => [token.address, token.value])),
      usdPerEur: rates.usd,
    }
  }, [format, rates.usd, tokens.data])

  return <PortfolioPricingContext.Provider value={pricing}>{children}</PortfolioPricingContext.Provider>
}
