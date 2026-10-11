const SUPPORTED_LANGUAGES = ['en', 'es', 'fr'] as const

export type SupportedLanguage = (typeof SUPPORTED_LANGUAGES)[number]

/** Setting value meaning "follow the browser language". */
export const LANGUAGE_AUTO = 'auto'

/**
 * Resolve the effective UI language: 'auto' (or unset) maps the browser's
 * language to the closest supported locale, falling back to English.
 */
export function resolveLanguage(value: null | string | undefined): SupportedLanguage {
  const raw = !value || value === LANGUAGE_AUTO ? (typeof navigator !== 'undefined' ? navigator.language : 'en') : value
  const short = raw.toLowerCase().slice(0, 2)
  return (SUPPORTED_LANGUAGES as readonly string[]).includes(short) ? (short as SupportedLanguage) : 'en'
}
