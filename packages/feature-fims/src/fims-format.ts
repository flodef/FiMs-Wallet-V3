const currencyFormatter = new Intl.NumberFormat('fr-FR', {
  currency: 'EUR',
  maximumFractionDigits: 2,
  style: 'currency',
})
const percentFormatter = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 1, style: 'percent' })
const dateFormatter = new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'short', year: 'numeric' })

export function formatCurrency(value: number) {
  return currencyFormatter.format(value)
}

export function formatPercent(value: number) {
  return percentFormatter.format(value)
}

export function formatDate(iso: string) {
  return dateFormatter.format(new Date(iso))
}
