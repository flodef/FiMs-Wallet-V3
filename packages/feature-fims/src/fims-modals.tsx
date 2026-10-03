import { useAccountActive } from '@workspace/db-react/use-account-active'
import { useSetting } from '@workspace/db-react/use-setting'
import PortfolioModals, { type SendBlockContext } from '@workspace/feature-portfolio/portfolio-modals'
import type { DestinationAccount } from '@workspace/feature-portfolio/ui/portfolio-ui-send-destination'
import { useTranslation } from '@workspace/i18n'
import type { UiGroupedComboboxInputGroup } from '@workspace/ui/components/ui-grouped-combobox-input'
import { useMemo } from 'react'
import { useFimsAddressBook, useFimsMember, useFimsTokens } from './data-access/use-fims.tsx'
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
  const [sendCapSetting] = useSetting('sendCapEur')
  const tokens = useFimsTokens()

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

  // Outgoing send guards. Sends to the treasury always stay open — that is how
  // a debt gets settled on-chain and it is not an "external" withdrawal.
  // 1. Debt guard: outgoing sends are blocked while the member owes FiMs.
  // 2. Send cap: optional EUR limit (Settings → Send limit). The token's EUR
  //    price comes from the FiMs token list; unpriced tokens are not capped —
  //    this is a convenience guard, not a custody policy.
  const getSendBlock = useMemo(() => {
    const cap = Number.parseFloat(sendCapSetting ?? '')
    const hasCap = Number.isFinite(cap) && cap > 0
    const hasDebt = typeof debt === 'number' && debt > 0
    if (!hasDebt && !hasCap) {
      return undefined
    }
    return (send: SendBlockContext): null | string => {
      if (send.destination === FIMS_TREASURY_ADDRESS) {
        return null
      }
      if (hasDebt) {
        return t(($) => $.debtSendBlocked, { amount: format(debt) })
      }
      if (hasCap) {
        const price = tokens.data?.find((token) => token.address === send.mint)?.value
        const eur = price ? Number.parseFloat(send.amount) * price : Number.NaN
        if (Number.isFinite(eur) && eur > cap) {
          return t(($) => $.sendCapBlocked, { cap: format(cap), total: format(eur) })
        }
      }
      return null
    }
  }, [debt, sendCapSetting, tokens.data, t, format])

  return <PortfolioModals extraDestinationGroups={groups} getSendBlock={getSendBlock} />
}
