import type { Account } from '@workspace/db/account/account'
import { useAccountsLive } from '@workspace/db-react/use-accounts-live'
import { useNetworkLive } from '@workspace/db-react/use-network-live'
import { useSetting } from '@workspace/db-react/use-setting'
import { SettingsUiWalletConnect } from '@workspace/feature-settings/ui/settings-ui-wallet-connect'
import { useTranslation } from '@workspace/i18n'
import { Button } from '@workspace/ui/components/button'
import { UiIcon } from '@workspace/ui/components/ui-icon'
import { cn } from '@workspace/ui/lib/utils'
import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router'
import { demoStart } from './demo/demo-store.tsx'

// Guided entry point: three paths instead of bare buttons, each opening a
// short explanation before the action — the 12-words safety rules are the
// single most important thing a newcomer must read.
export function OnboardingFeatureIndex({ redirectTo }: { redirectTo: string }) {
  const { t } = useTranslation('onboarding')
  const navigate = useNavigate()
  const networks = useNetworkLive()
  const accounts = useAccountsLive()
  const [activeNetworkId, setActiveNetworkId] = useSetting('activeNetworkId')
  const [activeAccountId, setActiveAccountId] = useSetting('activeAccountId')
  const [expanded, setExpanded] = useState<'demo' | 'existing' | 'new' | null>(null)

  async function handleStartDemo() {
    const devnet = networks.find((network) => network.type === 'solana:devnet')
    const previousNetworkId = devnet && activeNetworkId !== devnet.id ? activeNetworkId : null
    if (devnet && previousNetworkId) {
      await setActiveNetworkId(devnet.id)
    }
    demoStart({ accountId: activeAccountId, networkId: previousNetworkId })
    await navigate('import')
  }

  const externalConnected = accounts.some((account: Account) => !!account.externalWallet)

  // Connecting an external wallet creates accounts but does not pick one:
  // without an active account the root loader would bounce the user straight
  // back here on Continue.
  const firstExternal = accounts.find((account) => !!account.externalWallet)
  useEffect(() => {
    if (firstExternal && !activeAccountId) {
      setActiveAccountId(firstExternal.id).catch((error) => console.warn('onboarding: activate failed', error))
    }
  }, [firstExternal, activeAccountId, setActiveAccountId])

  return (
    <div className="flex flex-col items-center gap-6">
      <div className="flex flex-col items-center space-y-2">
        <div className="text-2xl">{t(($) => $.indexPageTitle)}</div>
        <div className="text-center text-lg text-muted-foreground">{t(($) => $.indexPageDescription)}</div>
      </div>
      <div className="flex w-full flex-col space-y-3">
        <OptionCard
          expanded={expanded === 'new'}
          onToggle={() => setExpanded(expanded === 'new' ? null : 'new')}
          title={t(($) => $.indexOptionNewTitle)}
        >
          <p className="whitespace-pre-line text-muted-foreground text-sm">{t(($) => $.indexOptionNewGuide)}</p>
          <Button className="w-full" onClick={() => navigate('generate')}>
            {t(($) => $.indexOptionNewAction)}
          </Button>
        </OptionCard>

        <OptionCard
          expanded={expanded === 'existing'}
          onToggle={() => setExpanded(expanded === 'existing' ? null : 'existing')}
          title={t(($) => $.indexOptionExistingTitle)}
        >
          <div className="space-y-2">
            <div className="rounded-md border p-3">
              <p className="font-medium">{t(($) => $.indexOptionImportTitle)}</p>
              <p className="mt-1 whitespace-pre-line text-muted-foreground text-sm">
                {t(($) => $.indexOptionImportGuide)}
              </p>
              <Button className="mt-3 w-full" onClick={() => navigate('import')} variant="secondary">
                {t(($) => $.indexOptionImportAction)}
              </Button>
            </div>
            <div className="rounded-md border p-3">
              <p className="font-medium">{t(($) => $.indexOptionExternalTitle)}</p>
              <p className="mt-1 whitespace-pre-line text-muted-foreground text-sm">
                {t(($) => $.indexOptionExternalGuide)}
              </p>
              <div className="mt-3">
                <SettingsUiWalletConnect />
              </div>
              {externalConnected ? (
                <Button className="mt-3 w-full" onClick={() => navigate(redirectTo)}>
                  {t(($) => $.indexOptionExternalConnected)}
                </Button>
              ) : null}
            </div>
          </div>
        </OptionCard>

        <OptionCard
          expanded={expanded === 'demo'}
          onToggle={() => setExpanded(expanded === 'demo' ? null : 'demo')}
          title={t(($) => $.indexOptionDemoTitle)}
        >
          <p className="whitespace-pre-line text-muted-foreground text-sm">{t(($) => $.indexOptionDemoGuide)}</p>
          <Button className="w-full" onClick={handleStartDemo} variant="outline">
            {t(($) => $.indexOptionDemoAction)}
          </Button>
        </OptionCard>
      </div>
    </div>
  )
}

function OptionCard({
  children,
  expanded,
  onToggle,
  title,
}: {
  children: React.ReactNode
  expanded: boolean
  onToggle: () => void
  title: string
}) {
  return (
    <div className="rounded-lg border">
      <button className="flex w-full items-center justify-between px-4 py-3 text-left" onClick={onToggle} type="button">
        <span className="font-medium">{title}</span>
        <UiIcon className={cn('size-4 transition-transform', expanded && 'rotate-90')} icon="chevronRight" />
      </button>
      {expanded ? <div className="space-y-3 border-t px-4 pt-3 pb-4">{children}</div> : null}
    </div>
  )
}
