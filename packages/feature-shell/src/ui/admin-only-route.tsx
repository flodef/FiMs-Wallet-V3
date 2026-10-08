import { useAccountActive } from '@workspace/db-react/use-account-active'
import { envAdminAddresses } from '@workspace/env/env'
import type { ReactNode } from 'react'
import { Navigate } from 'react-router'

/** Hides a route behind the admin allowlist — direct URLs bounce to
 *  /portfolio for regular users, same rule as the hidden nav entry. */
export function AdminOnlyRoute({ children }: { children: ReactNode }) {
  const account = useAccountActive()
  if (!envAdminAddresses().includes(account.publicKey)) {
    return <Navigate replace to="/portfolio" />
  }
  return <>{children}</>
}
