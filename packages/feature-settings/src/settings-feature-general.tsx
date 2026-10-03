import { useAccountActive } from '@workspace/db-react/use-account-active'
import { envAdminAddresses } from '@workspace/env/env'
import { useTranslation } from '@workspace/i18n'
import { Button } from '@workspace/ui/components/button'
import { UiCard } from '@workspace/ui/components/ui-card'
import { Link } from 'react-router'
import { useSettingsPage } from './data-access/use-settings-page.tsx'
import { SettingsFeatureGeneralApiSettings } from './settings-feature-general-api-settings.tsx'
import { SettingsFeatureGeneralLanguage } from './settings-feature-general-language.tsx'
import { SettingsFeatureGeneralSendCap } from './settings-feature-general-send-cap.tsx'
import { SettingsFeatureGeneralTheme } from './settings-feature-general-theme.tsx'
import { SettingsFeatureGeneralWarningAcceptExperimental } from './settings-feature-general-warning-accept-experimental.tsx'

export function SettingsFeatureGeneral() {
  const { t } = useTranslation('settings')
  const page = useSettingsPage({ pageId: 'general' })
  // The apiEndpoint override is admin-only: a malicious endpoint could serve a
  // poisoned address book and redirect outgoing transfers.
  const account = useAccountActive()
  const isAdmin = envAdminAddresses().includes(account.publicKey)
  return (
    <div className="space-y-2 md:space-y-4">
      <UiCard
        backButtonProps={{ className: 'md:hidden' }}
        backButtonTo="/settings"
        contentProps={{ className: 'space-y-2 md:space-y-6 md:py-2' }}
        description={page.description}
        title={page.name}
      >
        <SettingsFeatureGeneralLanguage />
        <SettingsFeatureGeneralTheme />
        <SettingsFeatureGeneralSendCap />
        <SettingsFeatureGeneralWarningAcceptExperimental />
      </UiCard>
      {isAdmin ? (
        <UiCard
          contentProps={{ className: 'space-y-2 md:space-y-6 md:py-2' }}
          title={t(($) => $.pageGeneralApiSettings)}
        >
          <SettingsFeatureGeneralApiSettings />
        </UiCard>
      ) : null}
      <UiCard
        className="border-red-500"
        contentProps={{ className: 'grid gap-6' }}
        title={t(($) => $.pageGeneralDangerZone)}
      >
        <Button asChild variant="destructive">
          <Link to="/reset">{t(($) => $.pageGeneralReset)}</Link>
        </Button>
      </UiCard>
    </div>
  )
}
