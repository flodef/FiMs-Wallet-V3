import { useIsAdmin } from '@workspace/db-react/use-is-admin'
import type { ReactNode } from 'react'
import { Navigate } from 'react-router'

/** Hides a route behind the admin allowlist — direct URLs bounce to
 *  /portfolio for regular users, same rule as the hidden nav entry. */
export function AdminOnlyRoute({ children }: { children: ReactNode }) {
  const isAdmin = useIsAdmin()
  if (!isAdmin) {
    return <Navigate replace to="/portfolio" />
  }
  return <>{children}</>
}
