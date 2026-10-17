import { hasAdminAccount } from '@workspace/db/session/resolve-session'
import { envAdminAddresses } from '@workspace/env/env'
import { useMemo } from 'react'
import { useAccountsLive } from './use-accounts-live.tsx'
import { useSetting } from './use-setting.tsx'

// Admin UI follows the ACTIVE account: admin API calls are signed by it, so
// showing admin controls for another account would only produce 403s. A
// watched account never counts — anyone can watch an admin's public key.
export function useIsAdmin(): boolean {
  const accounts = useAccountsLive()
  const [activeAccountId] = useSetting('activeAccountId')
  return useMemo(() => {
    const active = accounts.find((account) => account.id === activeAccountId)
    return !!active && hasAdminAccount([active], envAdminAddresses())
  }, [accounts, activeAccountId])
}

// Device-level admin: the device holds at least one admin signing key. Gates
// device settings (networks / test clusters) consistently with the root
// loader, so an admin switching to a personal account keeps the same access.
export function useHasAdminAccount(): boolean {
  const accounts = useAccountsLive()
  return useMemo(() => hasAdminAccount(accounts, envAdminAddresses()), [accounts])
}
