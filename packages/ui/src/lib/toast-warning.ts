import type { ReactNode } from 'react'

import { toast } from 'sonner'

export function toastWarning(message: ReactNode) {
  toast.warning(message)
}
