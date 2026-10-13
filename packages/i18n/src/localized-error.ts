import { i18n } from './index.ts'

// The app's `t` is typed against extractor-generated selector signatures;
// at runtime it still accepts plain key strings. These raw signatures keep
// the runtime call while the compile-time type stays out of the way.
const translate = i18n.t as unknown as (key: string, options?: Record<string, unknown>) => string
const exists = i18n.exists as unknown as (key: string, options?: Record<string, unknown>) => boolean

// Resolves the display text for any thrown value: errors carrying a stable
// code name (AppError) map to their `error<Name>` key in the 'ui' namespace
// and `params` flow into interpolation; ZodError collapses to a generic
// invalid-input message; plain Errors keep their English message; anything
// else stringifies. Every toast/inline error display should go through this
// so user-facing errors follow the chosen language.
export function localizedErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === 'ZodError') {
      return translate('errorInvalidInput', { ns: 'ui' })
    }
    if (error.name && error.name !== 'Error') {
      const key = `error${error.name.charAt(0).toUpperCase()}${error.name.slice(1)}`
      if (exists(key, { ns: 'ui' })) {
        const params = (error as { params?: Record<string, unknown> }).params
        return translate(key, { ns: 'ui', ...params })
      }
    }
    return error.message
  }
  return typeof error === 'string' ? error : String(error)
}
