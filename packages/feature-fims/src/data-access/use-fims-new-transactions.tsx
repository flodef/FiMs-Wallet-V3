import { useSetting } from '@workspace/db-react/use-setting'
import { useTranslation } from '@workspace/i18n'
import { toastSuccess } from '@workspace/ui/lib/toast-success'
import { useEffect, useRef } from 'react'
import type { FimsTransaction } from '../fims-api.ts'

// Toasts once per member when transactions newer than the persisted max id exist.
// The `fimsLastSeenTransaction` setting stores `${userId}:${maxTxId}`.
export function useFimsNewTransactions(userId: number | undefined, transactions: FimsTransaction[] | undefined) {
  const { t } = useTranslation('fims')
  const [stored, setStored] = useSetting('fimsLastSeenTransaction')
  const handled = useRef<number>(0)

  useEffect(() => {
    if (!userId || !transactions?.length || handled.current === userId) {
      return
    }
    handled.current = userId

    const [seenUserId, seenId] = (stored ?? '').split(':').map(Number)
    const maxId = Math.max(...transactions.map((tx) => tx.id))

    if (seenUserId === userId && seenId != null && Number.isFinite(seenId) && seenId < maxId) {
      const count = transactions.filter((tx) => tx.id > seenId).length
      toastSuccess(t(($) => $.newTransactions, { count }))
    }
    void setStored(`${userId}:${maxId}`)
  }, [userId, transactions, stored, setStored, t])
}
