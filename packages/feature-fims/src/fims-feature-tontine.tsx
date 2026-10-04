import type { Account } from '@workspace/db/account/account'
import { useTranslation } from '@workspace/i18n'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@workspace/ui/components/table'
import { UiCard } from '@workspace/ui/components/ui-card'
import { UiLoader } from '@workspace/ui/components/ui-loader'
import { useFimsTransactions, useFimsUserHistoric, useFimsUsers } from './data-access/use-fims.tsx'
import { useFimsCurrency } from './data-access/use-fims-currency.tsx'
import { formatDate } from './fims-format.ts'
import { FimsTxTypeLabel } from './fims-tx-type-label.tsx'
import { FimsUiHistoricChart } from './fims-ui-historic-chart.tsx'
import { FimsUiTontineDonate } from './fims-ui-tontine-donate.tsx'

// The tontine is stored as a regular member named "tontine": its user history
// gives the chart. Contributions are donations flagged donationTarget
// 'tontine' on the donor's own transaction list.
export function FimsFeatureTontine({ account }: { account: Account }) {
  const { t } = useTranslation('fims')
  const { format } = useFimsCurrency()
  const users = useFimsUsers()
  const tontineId = (users.data ?? []).find((u) => u.name.toLowerCase() === 'tontine')?.id
  const historic = useFimsUserHistoric(tontineId)
  const transactions = useFimsTransactions()
  const latest = historic.data?.at(-1)
  const nameById = new Map((users.data ?? []).map((u) => [u.id, u.name]))
  const contributions = (transactions.data ?? []).filter((tx) => tx.donationTarget === 'tontine')

  return (
    <div className="space-y-4">
      <UiCard title={t(($) => $.tontineTitle)}>
        {latest ? (
          <div className="mb-4 grid grid-cols-2 gap-4 text-center">
            <div>
              <div className="text-muted-foreground text-xs">{t(($) => $.tontineInvested)}</div>
              <div className="font-semibold">{format(latest.invested)}</div>
            </div>
            <div>
              <div className="text-muted-foreground text-xs">{t(($) => $.tontineValue)}</div>
              <div className="font-semibold">{latest.total != null ? format(latest.total) : '—'}</div>
            </div>
          </div>
        ) : null}
        {historic.isLoading ? (
          <UiLoader />
        ) : historic.data?.length ? (
          <FimsUiHistoricChart format={format} points={historic.data} />
        ) : null}
      </UiCard>

      <FimsUiTontineDonate account={account} />

      <UiCard title={t(($) => $.transactionsTitle)}>
        {transactions.isLoading ? (
          <UiLoader />
        ) : (
          <div className="max-h-96 overflow-y-auto">
            <Table>
              <TableHeader className="sticky top-0 bg-background">
                <TableRow>
                  <TableHead>{t(($) => $.columnDate)}</TableHead>
                  <TableHead>{t(($) => $.columnMember)}</TableHead>
                  <TableHead>{t(($) => $.columnToken)}</TableHead>
                  <TableHead>{t(($) => $.columnType)}</TableHead>
                  <TableHead className="text-right">{t(($) => $.columnAmount)}</TableHead>
                  <TableHead className="text-right">{t(($) => $.columnCost)}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {contributions.map((tx) => (
                  <TableRow key={tx.id}>
                    <TableCell>{formatDate(tx.date)}</TableCell>
                    <TableCell>{tx.userId != null ? (nameById.get(tx.userId) ?? '—') : '—'}</TableCell>
                    <TableCell>{tx.token ?? '—'}</TableCell>
                    <TableCell>
                      <FimsTxTypeLabel transaction={tx} />
                    </TableCell>
                    <TableCell className="text-right">{tx.amount ?? '—'}</TableCell>
                    <TableCell className="text-right">{format(tx.cost)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </UiCard>
    </div>
  )
}
