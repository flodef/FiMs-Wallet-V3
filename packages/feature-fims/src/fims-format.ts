const currencyFormatters: Record<string, Intl.NumberFormat> = {
  EUR: new Intl.NumberFormat('fr-FR', { currency: 'EUR', maximumFractionDigits: 2, style: 'currency' }),
  USD: new Intl.NumberFormat('en-US', { currency: 'USD', maximumFractionDigits: 2, style: 'currency' }),
}
const percentFormatter = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 1, style: 'percent' })
const dateFormatter = new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'short', year: 'numeric' })

export type FimsCurrency = 'EUR' | 'USD'

export function formatCurrency(value: number, currency: FimsCurrency = 'EUR', eurUsdRate = 1) {
  const converted = currency === 'USD' ? value * eurUsdRate : value
  return (currencyFormatters[currency] ?? currencyFormatters['EUR'] ?? new Intl.NumberFormat()).format(converted)
}

export function formatPercent(value: number) {
  return percentFormatter.format(value)
}

export function formatDate(iso: string) {
  return dateFormatter.format(new Date(iso))
}
