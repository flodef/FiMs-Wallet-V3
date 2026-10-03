import { AlertTriangle } from 'lucide-react'
import type { ReactNode } from 'react'
import { Alert, AlertDescription } from './alert.tsx'

export function UiWarning({ children }: { children: ReactNode }) {
  return (
    <Alert className="border-yellow-500 bg-yellow-500/10 text-yellow-600 dark:text-yellow-500">
      <AlertTriangle />
      <AlertDescription>{children}</AlertDescription>
    </Alert>
  )
}
