import type { Account } from '@workspace/db/account/account'
import { useMemo } from 'react'
import type { FimsUser } from '../fims-api.ts'
import { FIMS_DONATION_RATIO } from '../fims-constants.ts'
import { getFimsTransactionType } from '../fims-transaction-type.ts'
import { useFimsTransactions, useFimsUserHistoric } from './use-fims.tsx'

// Legacy spreadsheet rule: a member owes 10% of their gains, minus what they
// already gave (donation + tontine transactions). While this debt is positive
// the wallet blocks outgoing operations until it is settled.
export function useFimsDebt(member: FimsUser | null, account?: Account) {
  const historic = useFimsUserHistoric(member?.id, account)
  const transactions = useFimsTransactions(member ? { userId: member.id } : undefined, account)

  const debt = useMemo(() => {
    if (!member) return null
    const latest = historic.data?.at(-1)
    if (latest?.total == null) return null
    const pnl = latest.total - latest.invested
    if (pnl <= 0) return 0
    const donated = (transactions.data ?? [])
      .filter((tx) => ['donation', 'tontine'].includes(getFimsTransactionType(tx)))
      .reduce((sum, tx) => sum + (tx.movement ?? 0), 0)
    return Math.max(0, pnl * FIMS_DONATION_RATIO - donated)
  }, [member, historic.data, transactions.data])

  return { debt, isLoading: historic.isLoading || transactions.isLoading }
}
