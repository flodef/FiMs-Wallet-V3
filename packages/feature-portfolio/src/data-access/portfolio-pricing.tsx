import { formatMoney } from '@workspace/i18n/format'
import { bigIntToDecimal } from '@workspace/solana-client/big-int-to-decimal'
import type { TokenMetadata } from '@workspace/solana-client/get-token-metadata-jupiter'
import { createContext, useContext } from 'react'

// Valuation is injected by the shell (dependency inversion): feature-fims —
// which itself depends on this package — knows the FiMs token prices and the
// user's display currency. Without a provider the portfolio falls back to
// plain USD from Jupiter.
export interface PortfolioPricing {
  // Display a value expressed in EUR in the user's currency.
  format: (eur: number) => string
  // Display metadata for mints Jupiter does not list (name/symbol).
  metadata?: ReadonlyMap<string, TokenMetadata>
  // EUR price per unit for mints Jupiter does not price (FiMs, FLiP, FiMsSOL).
  pricesEur: ReadonlyMap<string, number>
  // USD per 1 EUR — converts Jupiter USD prices into EUR.
  usdPerEur: number
}

const defaultPricing: PortfolioPricing = {
  format: (eur) => formatMoney(eur, 'USD'),
  pricesEur: new Map(),
  usdPerEur: 1,
}

export const PortfolioPricingContext = createContext<PortfolioPricing>(defaultPricing)

export function usePortfolioPricing(): PortfolioPricing {
  return useContext(PortfolioPricingContext)
}

// Value of a balance in EUR, or null when no price source knows the mint.
// The protocol's own price wins over Jupiter for FiMs-family mints.
export function tokenValueEur(
  item: { balance: bigint; decimals: number; mint: string; usdPrice?: null | number | undefined },
  pricing: PortfolioPricing,
): null | number {
  const amount = bigIntToDecimal(item.balance, item.decimals)
  const eurPrice = pricing.pricesEur.get(item.mint)
  if (eurPrice !== undefined) {
    return amount * eurPrice
  }
  if (item.usdPrice && pricing.usdPerEur > 0) {
    return (amount * item.usdPrice) / pricing.usdPerEur
  }
  return null
}
