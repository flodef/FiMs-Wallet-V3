import { useAccountsLive } from '@workspace/db-react/use-accounts-live'
import { useBookmarkAccountLive } from '@workspace/db-react/use-bookmark-account-live'
import { formatBalance } from '@workspace/feature-explorer/data-access/format-balance'
import { useTranslation } from '@workspace/i18n'
import {
  FIMS_DEMO_RECIPIENT,
  FIMS_TONTINE_RECIPIENT,
  FIMS_TREASURY_RECIPIENT,
} from '@workspace/solana-client/fims-known-recipients'
import type { TransferRecipient } from '@workspace/solana-client/transfer-recipient'
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@workspace/ui/components/field'
import { Input } from '@workspace/ui/components/input'
import { UiWarning } from '@workspace/ui/components/ui-warning'
import { useId, useMemo } from 'react'
import { findLookalikeAddress } from '../data-access/find-lookalike-address.ts'
import type { TokenBalance } from '../data-access/use-get-token-balances.ts'

export function PortfolioUiSendConfirmDestination({
  mint,
  recipient: { amount, destination },
}: {
  mint: TokenBalance
  recipient: TransferRecipient
}) {
  const { t } = useTranslation('portfolio')
  const destinationId = useId()
  const amountId = useId()
  const accounts = useAccountsLive()
  const bookmarks = useBookmarkAccountLive() ?? []
  const lookalike = useMemo(
    () =>
      findLookalikeAddress({
        destination,
        knownAddresses: [
          ...(accounts ?? []).map((account) => account.publicKey),
          ...bookmarks.map((bookmark) => bookmark.address),
        ],
      }),
    [accounts, bookmarks, destination],
  )
  // Who is this? Own accounts and address-book entries resolve to a name;
  // the small FiMs registry resolves to a translated label; anything else
  // is an unknown recipient and gets a warning.
  const recipientLabel = useMemo(() => {
    const own = (accounts ?? []).find((account) => account.publicKey === destination)
    if (own) return own.name
    const bookmark = bookmarks.find((entry) => entry.address === destination)
    if (bookmark?.label) return bookmark.label
    const knownLabels: Record<string, string> = {
      [FIMS_DEMO_RECIPIENT]: t(($) => $.sendConfirmRecipientDemo),
      [FIMS_TONTINE_RECIPIENT]: t(($) => $.sendConfirmRecipientTontine),
      [FIMS_TREASURY_RECIPIENT]: t(($) => $.sendConfirmRecipientTreasury),
    }
    return knownLabels[destination] ?? null
  }, [accounts, bookmarks, destination, t])

  return (
    <FieldGroup>
      <Field>
        <FieldLabel htmlFor={destinationId}>{t(($) => $.sendInputDestinationLabel)}</FieldLabel>
        <Input
          defaultValue={destination}
          disabled
          id={destinationId}
          placeholder={t(($) => $.sendInputDestinationPlaceholder)}
          readOnly
          type="text"
        />
        {recipientLabel ? <FieldDescription>{recipientLabel}</FieldDescription> : null}
        {lookalike ? <UiWarning>{t(($) => $.sendConfirmAddressLookalike)}</UiWarning> : null}
        {!lookalike && !recipientLabel ? <UiWarning>{t(($) => $.sendConfirmUnknownRecipient)}</UiWarning> : null}
        {/* The demo wallet's mnemonic is public — its friendly label must
            never read as "safe". */}
        {destination === FIMS_DEMO_RECIPIENT ? (
          <UiWarning>{t(($) => $.sendConfirmRecipientDemoWarning)}</UiWarning>
        ) : null}
      </Field>
      <Field>
        <FieldLabel htmlFor={amountId}>{t(($) => $.sendInputAmountLabel)}</FieldLabel>
        <Input
          defaultValue={formatBalance({ balance: amount, decimals: mint.decimals })}
          disabled
          id={amountId}
          placeholder={t(($) => $.sendInputAmountPlaceholder)}
          readOnly
          type="text"
        />
      </Field>
    </FieldGroup>
  )
}
