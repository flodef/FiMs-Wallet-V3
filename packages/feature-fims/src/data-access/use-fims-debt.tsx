import type { Account } from '@workspace/db/account/account'
import { useMemo } from 'react'
import type { FimsUser } from '../fims-api.ts'
import { computeFimsDebt } from '../fims-debt.ts'
import { getFimsTontineRate } from '../fims-fee-config.ts'
import { useFimsTransactions, useFimsUserHistoric } from './use-fims.tsx'

// Legacy spreadsheet rule: a member owes the tontine rate (min 10%) of their
// gains, minus what they already gave (donation + tontine transactions).
// While this debt is positive the wallet blocks outgoing operations until
// it is settled.
export function useFimsDebt(member: FimsUser | null, account?: Account) {
  const historic = useFimsUserHistoric(member?.id, account)
  const transactions = useFimsTransactions(member ? { userId: member.id } : undefined, account)

  const debt = useMemo(() => {
    if (!member) return null
    const latest = historic.data?.at(-1)
    if (latest?.total == null) return null
    return computeFimsDebt(latest.total, transactions.data ?? [], getFimsTontineRate())
  }, [member, historic.data, transactions.data])

  // Current total position value (EUR) — drives the exit rule of the tontine
  // carve: a member cannot withdraw past position − debt.
  const position = useMemo(() => {
    if (!member) return null
    const latest = historic.data?.at(-1)
    return latest?.total ?? null
  }, [member, historic.data])

  return { debt, isLoading: historic.isLoading || transactions.isLoading, position }
}
