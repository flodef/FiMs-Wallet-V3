import { useNetworkLive } from '@workspace/db-react/use-network-live'
import { useSetting } from '@workspace/db-react/use-setting'
import { useTranslation } from '@workspace/i18n'
import { Button } from '@workspace/ui/components/button'
import { UiExperimentalWarning } from '@workspace/ui/components/ui-experimental-warning'
import { Link, useNavigate } from 'react-router'
import { demoStart } from './demo/demo-store.tsx'

export function OnboardingFeatureIndex() {
  const { t } = useTranslation('onboarding')
  const navigate = useNavigate()
  const networks = useNetworkLive()
  const [activeNetworkId, setActiveNetworkId] = useSetting('activeNetworkId')
  const [activeAccountId] = useSetting('activeAccountId')
  const [warningAcceptExperimental, setWarningAcceptExperimental] = useSetting('warningAcceptExperimental')

  async function handleStartDemo() {
    const devnet = networks.find((network) => network.type === 'solana:devnet')
    const previousNetworkId = devnet && activeNetworkId !== devnet.id ? activeNetworkId : null
    if (devnet && previousNetworkId) {
      await setActiveNetworkId(devnet.id)
    }
    demoStart({ accountId: activeAccountId, networkId: previousNetworkId })
    await navigate('import')
  }

  return (
    <div className="flex flex-col items-center gap-6">
      <div className="flex flex-col items-center space-y-2">
        <div className="text-2xl">{t(($) => $.indexPageTitle)}</div>
        <div className="text-lg text-muted-foreground">{t(($) => $.indexPageDescription)}</div>
      </div>
      {warningAcceptExperimental === 'true' ? null : (
        <UiExperimentalWarning close={() => setWarningAcceptExperimental('true')} />
      )}
      <div className="flex w-full flex-col space-y-2">
        <Button asChild>
          <Link to="generate">{t(($) => $.indexLinkGenerate)}</Link>
        </Button>
        <Button asChild variant="secondary">
          <Link to="import">{t(($) => $.indexLinkImport)}</Link>
        </Button>
        <Button onClick={handleStartDemo} variant="outline">
          {t(($) => $.demoButtonStart)}
        </Button>
      </div>
    </div>
  )
}
