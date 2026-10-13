import { useAccountActive } from '@workspace/db-react/use-account-active'
import { useNetworkActive } from '@workspace/db-react/use-network-active'
import { useNetworkLive } from '@workspace/db-react/use-network-live'
import { useSetting } from '@workspace/db-react/use-setting'
import { envAdminAddresses } from '@workspace/env/env'

import { SettingsUiNetworkDropdown } from './ui/settings-ui-network-dropdown.tsx'

export function SettingsFeatureNetworkDropdown() {
  const networks = useNetworkLive()
  const [, setActiveNetworkId] = useSetting('activeNetworkId')
  const activeNetwork = useNetworkActive()
  const account = useAccountActive()
  // Non-mainnet networks are a debug feature: admins see them, everyone
  // else only sees mainnet.
  const isAdmin = envAdminAddresses().includes(account.publicKey)
  const items = isAdmin ? networks : networks.filter((n) => n.type === 'solana:mainnet')
  return <SettingsUiNetworkDropdown activeNetwork={activeNetwork} items={items} setActive={setActiveNetworkId} />
}
