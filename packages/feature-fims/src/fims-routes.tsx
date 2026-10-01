import { useAccountActive } from '@workspace/db-react/use-account-active'
import { useTranslation } from '@workspace/i18n'
import { UiPage } from '@workspace/ui/components/ui-page'
import { UiTabRoutes } from '@workspace/ui/components/ui-tab-routes'
import { FimsFeatureCommunity } from './fims-feature-community.tsx'
import { FimsFeatureMember } from './fims-feature-member.tsx'
import { FimsFeatureSwap } from './fims-feature-swap.tsx'

export default function FimsRoutes() {
  const { t } = useTranslation('fims')
  const account = useAccountActive()
  return (
    <UiPage>
      <UiTabRoutes
        basePath="/fims"
        className="mb-4 items-center lg:mb-6"
        tabs={[
          {
            element: <FimsFeatureMember account={account} />,
            label: t(($) => $.tabAccount),
            path: 'account',
          },
          {
            element: <FimsFeatureSwap account={account} />,
            label: t(($) => $.tabSwap),
            path: 'swap',
          },
          {
            element: <FimsFeatureCommunity />,
            label: t(($) => $.tabCommunity),
            path: 'community',
          },
        ]}
      />
      <p className="mt-6 text-center text-muted-foreground text-xs">{t(($) => $.disclaimer)}</p>
    </UiPage>
  )
}
