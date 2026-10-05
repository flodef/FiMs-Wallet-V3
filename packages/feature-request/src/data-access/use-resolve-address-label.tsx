import { useAccountsLive } from '@workspace/db-react/use-accounts-live'
import { useBookmarkAccountLive } from '@workspace/db-react/use-bookmark-account-live'
import { useTranslation } from '@workspace/i18n'
import {
  FIMS_DEMO_RECIPIENT,
  FIMS_TONTINE_RECIPIENT,
  FIMS_TREASURY_RECIPIENT,
} from '@workspace/solana-client/fims-known-recipients'
import { useCallback } from 'react'

// Resolves an address to a member-facing name: own accounts first, then the
// address book, then the small FiMs registry (treasury, tontine, demo).
// Returns null for addresses the wallet does not know — callers turn that
// into an unknown-recipient warning.
export function useResolveAddressLabel() {
  const accounts = useAccountsLive()
  const bookmarks = useBookmarkAccountLive() ?? []
  const { t } = useTranslation('request')

  return useCallback(
    (address: string): string | null => {
      const own = (accounts ?? []).find((account) => account.publicKey === address)
      if (own) return own.name
      const bookmark = bookmarks.find((entry) => entry.address === address)
      if (bookmark?.label) return bookmark.label
      const knownLabels: Record<string, string> = {
        [FIMS_DEMO_RECIPIENT]: t(($) => $.recipientDemo),
        [FIMS_TONTINE_RECIPIENT]: t(($) => $.recipientTontine),
        [FIMS_TREASURY_RECIPIENT]: t(($) => $.recipientTreasury),
      }
      return knownLabels[address] ?? null
    },
    [accounts, bookmarks, t],
  )
}
