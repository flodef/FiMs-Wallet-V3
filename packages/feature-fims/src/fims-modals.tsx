import { useAccountActive } from '@workspace/db-react/use-account-active'
import PortfolioModals from '@workspace/feature-portfolio/portfolio-modals'
import type { DestinationAccount } from '@workspace/feature-portfolio/ui/portfolio-ui-send-destination'
import { useTranslation } from '@workspace/i18n'
import type { UiGroupedComboboxInputGroup } from '@workspace/ui/components/ui-grouped-combobox-input'
import { useMemo } from 'react'
import { useFimsAddressBook, useFimsMember } from './data-access/use-fims.tsx'
import { useFimsCurrency } from './data-access/use-fims-currency.tsx'
import { useFimsDebt } from './data-access/use-fims-debt.tsx'
import { FIMS_TREASURY_ADDRESS } from './fims-constants.ts'

// Wraps the portfolio send/receive modals and injects the member's FiMs address
// book as an extra destination group.
export default function FimsModals() {
  const { t } = useTranslation('fims')
  const { format } = useFimsCurrency()
  const account = useAccountActive()
  const { member } = useFimsMember(account.publicKey, account)
  const entries = useFimsAddressBook(member?.id, account)
  const { debt } = useFimsDebt(member, account)

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

  // Debt guard: outgoing sends are blocked while the member owes FiMs (10% of
  // gains rule). Sends to the treasury stay open — that is how the debt gets
  // settled on-chain.
  const getSendBlock = useMemo(
    () =>
      debt && debt > 0
        ? (destination: string) =>
            destination === FIMS_TREASURY_ADDRESS ? null : t(($) => $.debtSendBlocked, { amount: format(debt) })
        : undefined,
    [debt, t, format],
  )

  return <PortfolioModals extraDestinationGroups={groups} getSendBlock={getSendBlock} />
}
