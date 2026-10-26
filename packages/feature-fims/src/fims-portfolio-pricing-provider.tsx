import {
  PortfolioLedgerContext,
  type PortfolioLedgerRow,
  type PortfolioLedgerSourceProps,
} from '@workspace/feature-portfolio/data-access/portfolio-ledger'
import {
  type PortfolioPricing,
  PortfolioPricingContext,
} from '@workspace/feature-portfolio/data-access/portfolio-pricing'
import { type ReactNode, useMemo } from 'react'
import { useFimsMember, useFimsTokens, useFimsTransactions } from './data-access/use-fims.tsx'
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
          // decimals is a placeholder: FiMs prices come from `pricesEur`, no
          // consumer reads `metadata.decimals` for these mints. Keep it
          // explicit so a future balance formatter doesn't silently treat the
          // unit as whole tokens.
          { decimals: 0, icon: '', id: token.address, name: token.label, symbol: token.symbol, usdPrice: 0 },
        ]),
      ),
      pricesEur: new Map(priced.map((token) => [token.address, token.value])),
      usdPerEur: rates.usd,
    }
  }, [format, rates.usd, tokens.data])

  return <PortfolioPricingContext.Provider value={pricing}>{children}</PortfolioPricingContext.Provider>
}

// Ledger side of the portfolio injection: resolves the watched address to a
// member and streams its `transactions` rows + the symbol→mint map so the
// chain reader can build an exact EUR cost basis for protocol tokens.
function FimsLedgerSource({ address, children, enabled, signer }: PortfolioLedgerSourceProps) {
  // `enabled` carries the reader consent: until granted, NO signed
  // member/transactions request may leak "signer X reads target Y".
  const member = useFimsMember(address, signer, enabled)
  const transactions = useFimsTransactions(
    member.member ? { userId: member.member.id } : undefined,
    signer,
    // A watched non-member address must not fold every member's ledger
    // into its P&L — no member, no fetch, no rows.
    enabled && !!member.member,
  )
  const tokens = useFimsTokens()
  const data = useMemo(
    () => ({
      mintBySymbol: new Map(
        (tokens.data ?? []).flatMap((token) => (token.address ? [[token.symbol, token.address] as const] : [])),
      ),
      rows: (transactions.data ?? []) as PortfolioLedgerRow[],
    }),
    [tokens.data, transactions.data],
  )
  return <>{children(data)}</>
}

export function FimsPortfolioLedgerProvider({ children }: { children: ReactNode }) {
  return <PortfolioLedgerContext.Provider value={FimsLedgerSource}>{children}</PortfolioLedgerContext.Provider>
}
