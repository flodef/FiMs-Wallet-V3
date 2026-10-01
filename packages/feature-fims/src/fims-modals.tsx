import { useAccountActive } from '@workspace/db-react/use-account-active'
import PortfolioModals from '@workspace/feature-portfolio/portfolio-modals'
import type { DestinationAccount } from '@workspace/feature-portfolio/ui/portfolio-ui-send-destination'
import { useTranslation } from '@workspace/i18n'
import type { UiGroupedComboboxInputGroup } from '@workspace/ui/components/ui-grouped-combobox-input'
import { useMemo } from 'react'
import { useFimsAddressBook, useFimsMember } from './data-access/use-fims.tsx'

// Wraps the portfolio send/receive modals and injects the member's FiMs address
// book as an extra destination group.
export default function FimsModals() {
  const { t } = useTranslation('fims')
  const account = useAccountActive()
  const { member } = useFimsMember(account.publicKey)
  const entries = useFimsAddressBook(member?.id)

  const groups = useMemo<UiGroupedComboboxInputGroup<DestinationAccount>[]>(
    () =>
      entries.data?.length
        ? [
            {
              items: entries.data.map((entry) => ({
                address: entry.address,
                id: `fims-${entry.id}`,
                isSource: false,
                label: entry.label,
              })),
              label: t(($) => $.addressBookTitle),
            },
          ]
        : [],
    [entries.data, t],
  )

  return <PortfolioModals extraDestinationGroups={groups} />
}
