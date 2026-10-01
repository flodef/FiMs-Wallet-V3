import { useAccountActive } from '@workspace/db-react/use-account-active'
import { useTranslation } from '@workspace/i18n'
import { UiPage } from '@workspace/ui/components/ui-page'
import { UiTabRoutes } from '@workspace/ui/components/ui-tab-routes'
import { useSnsResolveDomain } from './data-access/use-sns-domain.tsx'
import { FIMS_AUDIT_URL, FIMS_TREASURY_ADDRESS, FIMS_TREASURY_DOMAIN } from './fims-constants.ts'
import { FimsFeatureCommunity } from './fims-feature-community.tsx'
import { FimsFeatureLearn } from './fims-feature-learn.tsx'
import { FimsFeatureMember } from './fims-feature-member.tsx'
import { FimsFeatureSwap } from './fims-feature-swap.tsx'
import { FimsFeatureTontine } from './fims-feature-tontine.tsx'
import { FimsFeatureVotes } from './fims-feature-votes.tsx'

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
          {
            element: <FimsFeatureTontine />,
            label: t(($) => $.tabTontine),
            path: 'tontine',
          },
          {
            element: <FimsFeatureVotes account={account} />,
            label: t(($) => $.tabVotes),
            path: 'votes',
          },
          {
            element: <FimsFeatureLearn />,
            label: t(($) => $.tabLearn),
            path: 'learn',
          },
        ]}
      />
      <p className="mt-6 text-center text-muted-foreground text-xs">{t(($) => $.disclaimer)}</p>
      <FimsAuditLink />
    </UiPage>
  )
}

// Public audit view of the treasury on Jupiter. The .sol name is only shown
// when the on-chain SNS record actually resolves to the treasury address.
function FimsAuditLink() {
  const { t } = useTranslation('fims')
  const owner = useSnsResolveDomain(FIMS_TREASURY_DOMAIN)
  return (
    <p className="mt-2 text-center text-muted-foreground text-xs">
      <a className="underline hover:opacity-80" href={FIMS_AUDIT_URL} rel="noreferrer" target="_blank">
        {t(($) => $.auditLink)}
        {owner.data === FIMS_TREASURY_ADDRESS ? ` — ${FIMS_TREASURY_DOMAIN}` : ''}
      </a>
    </p>
  )
}
