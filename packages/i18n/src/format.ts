import i18n from 'i18next'
import { resolveLanguage, type SupportedLanguage } from './resolve-language.ts'

// Locale-aware formatting that follows the language chosen in Settings —
// never a hardcoded 'en-US' / 'fr-FR'. Formatters are cached per locale and
// options because Intl constructors are expensive.

const LOCALE_TAGS: Record<SupportedLanguage, string> = { en: 'en-US', es: 'es-ES', fr: 'fr-FR' }

export function formatLocale(): string {
  return LOCALE_TAGS[resolveLanguage(i18n.resolvedLanguage ?? i18n.language)]
}

const numberFormatters = new Map<string, Intl.NumberFormat>()
const dateFormatters = new Map<string, Intl.DateTimeFormat>()

function cached<T>(cache: Map<string, T>, options: object, create: (locale: string) => T): T {
  const locale = formatLocale()
  const key = `${locale}|${JSON.stringify(options)}`
  let formatter = cache.get(key)
  if (!formatter) {
    formatter = create(locale)
    cache.set(key, formatter)
  }
  return formatter
}

export function formatNumber(value: number, options: Intl.NumberFormatOptions = {}): string {
  return cached(numberFormatters, options, (locale) => new Intl.NumberFormat(locale, options)).format(value)
}

export function formatMoney(value: number, currency: string, options: Intl.NumberFormatOptions = {}): string {
  return formatNumber(value, { currency, maximumFractionDigits: 2, style: 'currency', ...options })
}

export function formatDateTime(value: Date | number | string, options: Intl.DateTimeFormatOptions = {}): string {
  const date = value instanceof Date ? value : new Date(value)
  return cached(dateFormatters, options, (locale) => new Intl.DateTimeFormat(locale, options)).format(date)
}

// Display a lamport amount as SOL in the current locale (9 decimals max).
export function formatLamports(lamports: bigint | number, decimals = 9): string {
  return formatNumber(Number(lamports) / 1_000_000_000, {
    maximumFractionDigits: Math.min(decimals, 9),
    minimumFractionDigits: 0,
  })
}
