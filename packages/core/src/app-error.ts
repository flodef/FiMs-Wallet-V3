// An Error carrying a stable machine-readable `name` so the UI can map it
// to a localized message (i18n key `error<Name>` in the 'ui' namespace).
// `message` stays the English fallback for untranslated display paths.
//
// The third argument is either i18n interpolation `params` (`{ count }`,
// `{ id }`…) or `{ cause }` to preserve the native Error#cause chain — a
// mixed `{ cause, ...params }` object splits both.
export class AppError extends Error {
  readonly params: Record<string, unknown> | undefined

  constructor(name: string, message: string, options?: { cause?: unknown } & Record<string, unknown>) {
    super(message)
    this.name = name
    if (options && 'cause' in options) {
      const { cause, ...params } = options
      this.cause = cause
      this.params = Object.keys(params).length ? params : undefined
    } else {
      this.params = options
    }
  }
}

// Thrown when the active wallet/account vanished mid-session — the route
// error boundary turns it into an onboarding redirect, not a bug page.
export class NoActiveAccountError extends AppError {
  constructor() {
    super('noActiveAccount', 'No active account set.')
  }
}
