import { localizedErrorMessage } from '@workspace/i18n/localized-error'
import { isValidElement, type ReactNode } from 'react'
import { toast } from 'sonner'

// Accepts a raw thrown value too — coded errors resolve to the localized
// message in the user's language, plain messages pass through unchanged.
export function toastError(input: ReactNode | unknown) {
  toast.error(isValidElement(input) || typeof input === 'string' ? (input as ReactNode) : localizedErrorMessage(input))
}
