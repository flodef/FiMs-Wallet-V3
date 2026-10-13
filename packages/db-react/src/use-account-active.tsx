import { useMemo } from 'react'
import { useAccountsLive } from './use-accounts-live.tsx'
import { useSetting } from './use-setting.tsx'

// Named so the route error boundary can turn this crash into an onboarding
// redirect without importing the class across package boundaries.
export class NoActiveAccountError extends Error {
  constructor() {
    super('No active account set.')
    this.name = 'NoActiveAccountError'
  }
}

export function useAccountActive() {
  const accounts = useAccountsLive()
  const [activeAccountId] = useSetting('activeAccountId')
  const accountActive = useMemo(() => accounts.find((item) => item.id === activeAccountId), [activeAccountId, accounts])
  if (!accountActive) {
    throw new NoActiveAccountError()
  }

  return accountActive
}
