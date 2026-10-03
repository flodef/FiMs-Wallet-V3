import { useAccountActive } from '@workspace/db-react/use-account-active'
import { envAdminAddresses } from '@workspace/env/env'
import { useTranslation } from '@workspace/i18n'
import type { SettingsPage } from './settings-page.ts'

export function useSettingsPages(): SettingsPage[] {
  const { t } = useTranslation('settings')
  // Network management can point the app at a hostile RPC, so it is admin-only:
  // hidden from the settings list and guarded in the router.
  const account = useAccountActive()
  const isAdmin = envAdminAddresses().includes(account.publicKey)
  return [
    {
      description: t(($) => $.pageGeneralDescription),
      icon: 'settings',
      id: 'general',
      name: t(($) => $.pageGeneralName),
    },
    ...(isAdmin
      ? [
          {
            description: t(($) => $.pageNetworkDescription),
            icon: 'network' as const,
            id: 'networks',
            name: t(($) => $.pageNetworkName),
          },
        ]
      : []),
    {
      description: t(($) => $.pageWalletDescription),
      icon: 'wallet',
      id: 'wallets',
      name: t(($) => $.pageWalletName),
    },
  ]
}
