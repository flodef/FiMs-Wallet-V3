import { useAccountActive } from '@workspace/db-react/use-account-active'
import { envAdminAddresses } from '@workspace/env/env'
import { Navigate, useRoutes } from 'react-router'
import { SettingsFeatureAccountGenerateVanity } from './settings-feature-account-generate-vanity.tsx'
import { SettingsFeatureGeneral } from './settings-feature-general.tsx'
import { SettingsFeatureNetworkCreate } from './settings-feature-network-create.tsx'
import { SettingsFeatureNetworkList } from './settings-feature-network-list.tsx'
import { SettingsFeatureNetworkUpdate } from './settings-feature-network-update.tsx'
import { SettingsFeatureWalletAddAccount } from './settings-feature-wallet-add-account.tsx'
import { SettingsFeatureWalletCreate } from './settings-feature-wallet-create.tsx'
import { SettingsFeatureWalletDetails } from './settings-feature-wallet-details.tsx'
import { SettingsFeatureWalletGenerate } from './settings-feature-wallet-generate.tsx'
import { SettingsFeatureWalletImport } from './settings-feature-wallet-import.tsx'
import { SettingsFeatureWalletList } from './settings-feature-wallet-list.tsx'
import { SettingsFeatureWalletUpdate } from './settings-feature-wallet-update.tsx'
import { SettingsUiLayout } from './ui/settings-ui-layout.tsx'

export default function SettingsRoutes() {
  // Network create/update can point the app at a hostile RPC — admin-only,
  // enforced here too (not just hidden in the page list) since URLs can be
  // navigated to directly.
  const account = useAccountActive()
  const isAdmin = envAdminAddresses().includes(account.publicKey)
  return useRoutes([
    {
      children: [
        { element: <SettingsFeatureGeneral />, index: true },
        {
          children: [
            { element: <SettingsFeatureWalletList />, index: true },
            { element: <SettingsFeatureWalletCreate />, path: 'create' },
            { element: <SettingsFeatureWalletGenerate />, path: 'generate' },
            { element: <SettingsFeatureWalletImport />, path: 'import' },
            { element: <SettingsFeatureWalletDetails />, path: ':walletId' },
            { element: <SettingsFeatureWalletAddAccount />, path: ':walletId/add' },
            { element: <SettingsFeatureAccountGenerateVanity />, path: ':walletId/add/generate-vanity' },
            { element: <SettingsFeatureWalletUpdate />, path: ':walletId/edit' },
          ],
          path: 'wallets',
        },
        {
          children: [
            { element: isAdmin ? <SettingsFeatureNetworkList /> : <Navigate replace to="/settings" />, index: true },
            {
              element: isAdmin ? <SettingsFeatureNetworkCreate /> : <Navigate replace to="/settings" />,
              path: 'create',
            },
            {
              element: isAdmin ? <SettingsFeatureNetworkUpdate /> : <Navigate replace to="/settings" />,
              path: ':networkId',
            },
          ],
          path: 'networks',
        },
        {
          children: [{ element: <SettingsFeatureGeneral />, index: true }],
          path: 'general',
        },
      ],
      element: <SettingsUiLayout />,
    },
  ])
}
