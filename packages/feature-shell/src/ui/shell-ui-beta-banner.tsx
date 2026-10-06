import { useTranslation } from '@workspace/i18n'
import { Alert, AlertDescription, AlertTitle } from '@workspace/ui/components/alert'
import { UiIcon } from '@workspace/ui/components/ui-icon'

// Big "experimental software" banner shown while the app is served from the
// beta hostname. Remove this component (and its i18n keys) when the app moves
// to wallet.fims.fi.
const BETA_HOSTNAME = 'wallet-v3.fims.fi'

export function ShellUiBetaBanner() {
  const { t } = useTranslation('shell')
  if (typeof window === 'undefined' || window.location.hostname !== BETA_HOSTNAME) {
    return null
  }

  return (
    <Alert className="rounded-none border-x-0 border-t-0" variant="warning">
      <UiIcon icon="alert" />
      <AlertTitle>{t(($) => $.betaWarningTitle)}</AlertTitle>
      <AlertDescription>{t(($) => $.betaWarningBody)}</AlertDescription>
    </Alert>
  )
}
