import type { Signature } from '@solana/kit'

import { useBookmarkTransactionFindBySignature } from '@workspace/db-react/use-bookmark-transaction-find-by-signature'
import { useBookmarkTransactionToggle } from '@workspace/db-react/use-bookmark-transaction-toggle'
import { i18n } from '@workspace/i18n'
import { toastError } from '@workspace/ui/lib/toast-error'
import { toastSuccess } from '@workspace/ui/lib/toast-success'

export function useExplorerBookmarkTransaction({ signature }: { signature: Signature }) {
  const bookmarkTransaction = useBookmarkTransactionFindBySignature({ signature })
  const mutationToggle = useBookmarkTransactionToggle()

  return {
    hasBookmark: Boolean(bookmarkTransaction),
    toggle: async () => {
      try {
        const result = await mutationToggle.mutateAsync({ signature })
        toastSuccess(
          result === 'created'
            ? i18n.t(($) => $.bookmarkAdded, { ns: 'explorer' })
            : i18n.t(($) => $.bookmarkRemoved, { ns: 'explorer' }),
        )
      } catch (e) {
        console.log(e)
        toastError(i18n.t(($) => $.toastBookmarkToggleFailed, { ns: 'ui' }))
      }
    },
  }
}
