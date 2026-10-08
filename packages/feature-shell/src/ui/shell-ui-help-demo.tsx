import { useNetworkLive } from '@workspace/db-react/use-network-live'
import { useSetting } from '@workspace/db-react/use-setting'
import { demoStart } from '@workspace/feature-onboarding/demo/demo-store'
import { useTranslation } from '@workspace/i18n'
import { Button } from '@workspace/ui/components/button'
import { UiIcon } from '@workspace/ui/components/ui-icon'
import { useNavigate } from 'react-router'

/** Header help button — replays the guided tour anytime. The demo runs on a
 *  public-mnemonic devnet wallet, so restarting it is safe: the previous
 *  account/network is restored on exit and the demo wallet is deleted. */
export function ShellUiHelpDemo() {
  const { t } = useTranslation('shell')
  const navigate = useNavigate()
  const networks = useNetworkLive()
  const [activeNetworkId, setActiveNetworkId] = useSetting('activeNetworkId')
  const [activeAccountId] = useSetting('activeAccountId')

  async function handleStartDemo() {
    const devnet = networks.find((network) => network.type === 'solana:devnet')
    const previousNetworkId = devnet && activeNetworkId !== devnet.id ? activeNetworkId : null
    if (devnet && previousNetworkId) {
      await setActiveNetworkId(devnet.id)
    }
    demoStart({ accountId: activeAccountId, networkId: previousNetworkId })
    await navigate('/onboarding/import')
  }

  return (
    <Button onClick={handleStartDemo} size="icon" title={t(($) => $.helpReplayDemo)} variant="ghost">
      <UiIcon icon="help" />
    </Button>
  )
}
