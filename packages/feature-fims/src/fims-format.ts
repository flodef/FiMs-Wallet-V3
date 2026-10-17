import { formatDateTime as formatLocaleDateTime, formatMoney, formatNumber } from '@workspace/i18n/format'

// Every formatter follows the language chosen in Settings (formatLocale) —
// no hardcoded 'fr-FR' / 'en-US'.

export type FimsCurrency = 'EUR' | 'SOL' | 'USD'

// Units per 1 EUR: e.g. rates.usd = 1.09, rates.sol = 1 / solPriceEur.
export interface FimsCurrencyRates {
  sol: number
  usd: number
}

export const DEFAULT_RATES: FimsCurrencyRates = { sol: 0, usd: 1 }

export function formatCurrency(
  value: number,
  currency: FimsCurrency = 'EUR',
  rates: FimsCurrencyRates = DEFAULT_RATES,
) {
  // SOL is not an ISO 4217 code — formatted manually.
  if (currency === 'SOL') {
    return rates.sol > 0 ? `${formatNumber(value * rates.sol, { maximumFractionDigits: 4 })} SOL` : '—'
  }
  return formatMoney(currency === 'USD' ? value * rates.usd : value, currency)
}

export function formatPercent(value: number) {
  return formatNumber(value, { maximumFractionDigits: 1, style: 'percent' })
}

export function formatDate(iso: string) {
  return formatLocaleDateTime(iso, { day: 'numeric', month: 'short', year: 'numeric' })
}

export function formatDateTime(iso: string) {
  return formatLocaleDateTime(iso, { day: 'numeric', hour: '2-digit', minute: '2-digit', month: 'short' })
}
