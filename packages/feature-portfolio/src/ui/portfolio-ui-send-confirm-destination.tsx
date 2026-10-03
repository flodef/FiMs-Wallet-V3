import { useAccountsLive } from '@workspace/db-react/use-accounts-live'
import { useBookmarkAccountLive } from '@workspace/db-react/use-bookmark-account-live'
import { formatBalance } from '@workspace/feature-explorer/data-access/format-balance'
import { useTranslation } from '@workspace/i18n'
import type { TransferRecipient } from '@workspace/solana-client/transfer-recipient'
import { Field, FieldGroup, FieldLabel } from '@workspace/ui/components/field'
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
        {lookalike ? <UiWarning>{t(($) => $.sendConfirmAddressLookalike)}</UiWarning> : null}
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
