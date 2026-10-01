const currencyFormatters: Record<string, Intl.NumberFormat> = {
  EUR: new Intl.NumberFormat('fr-FR', { currency: 'EUR', maximumFractionDigits: 2, style: 'currency' }),
  USD: new Intl.NumberFormat('en-US', { currency: 'USD', maximumFractionDigits: 2, style: 'currency' }),
}
// SOL is not an ISO 4217 code — formatted manually.
const solFormatter = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 4 })
const percentFormatter = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 1, style: 'percent' })
const dateFormatter = new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'short', year: 'numeric' })
const dateTimeFormatter = new Intl.DateTimeFormat('fr-FR', {
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  month: 'short',
})

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
  if (currency === 'SOL') {
    return rates.sol > 0 ? `${solFormatter.format(value * rates.sol)} SOL` : '—'
  }
  const converted = currency === 'USD' ? value * rates.usd : value
  return (currencyFormatters[currency] ?? currencyFormatters['EUR'] ?? new Intl.NumberFormat()).format(converted)
}

export function formatPercent(value: number) {
  return percentFormatter.format(value)
}

export function formatDate(iso: string) {
  return dateFormatter.format(new Date(iso))
}

export function formatDateTime(iso: string) {
  return dateTimeFormatter.format(new Date(iso))
}
