import type { Account } from '@workspace/db/account/account'
import { useTranslation } from '@workspace/i18n'
import { Badge } from '@workspace/ui/components/badge'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@workspace/ui/components/table'
import { UiCard } from '@workspace/ui/components/ui-card'
import { UiLoader } from '@workspace/ui/components/ui-loader'
import { useMemo } from 'react'
import { Link } from 'react-router'
import { useFimsMember, useFimsTokens, useFimsTransactions, useFimsUserHistoric } from './data-access/use-fims.tsx'
import { formatCurrency, formatDate, formatPercent } from './fims-format.ts'
import { computeFimsPositions } from './fims-positions.ts'
import { FimsUiAddressBook } from './fims-ui-address-book.tsx'

export function FimsFeatureMember({ account }: { account: Account }) {
  const address = account.publicKey
  const { t } = useTranslation('fims')
  const { isLoading, member } = useFimsMember(address)
  const historic = useFimsUserHistoric(member?.id)
  const transactions = useFimsTransactions(member ? { userId: member.id } : undefined)
  const tokens = useFimsTokens()
  const positions = useMemo(
    () => computeFimsPositions(transactions.data ?? [], tokens.data ?? []),
    [transactions.data, tokens.data],
  )

  if (isLoading) return <UiLoader />

  if (!member) {
    return (
      <UiCard title={t(($) => $.memberNotFoundTitle)}>
        <p className="text-muted-foreground text-sm">
          {t(($) => $.memberNotFoundDescription)}
          <br />
          <Link className="text-primary underline" to="/fims/community">
            {t(($) => $.memberNotFoundCommunityLink)}
          </Link>
        </p>
      </UiCard>
    )
  }

  const latest = historic.data?.at(-1)
  const pnl = latest?.total != null ? latest.total - latest.invested : null

  return (
    <div className="space-y-4">
      <UiCard
        action={
          <div className="flex gap-2">
            {member.isPro ? <Badge>{t(($) => $.badgePro)}</Badge> : null}
            <Badge variant="outline">{member.isPublic ? t(($) => $.badgePublic) : t(($) => $.badgePrivate)}</Badge>
          </div>
        }
        title={member.name}
      >
        <div className="grid grid-cols-3 gap-4 text-center">
          <div>
            <div className="text-muted-foreground text-xs">{t(($) => $.labelInvested)}</div>
            <div className="font-semibold">{latest ? formatCurrency(latest.invested) : '—'}</div>
          </div>
          <div>
            <div className="text-muted-foreground text-xs">{t(($) => $.labelCurrentValue)}</div>
            <div className="font-semibold">{latest?.total != null ? formatCurrency(latest.total) : '—'}</div>
          </div>
          <div>
            <div className="text-muted-foreground text-xs">{t(($) => $.labelPnl)}</div>
            <div className={pnl != null && pnl < 0 ? 'font-semibold text-red-500' : 'font-semibold text-green-500'}>
              {pnl != null ? formatCurrency(pnl) : '—'}
            </div>
          </div>
        </div>
      </UiCard>

      {positions.length ? (
        <UiCard title={t(($) => $.positionsTitle)}>
          <div className="max-h-96 overflow-y-auto">
            <Table>
              <TableHeader className="sticky top-0 bg-background">
                <TableRow>
                  <TableHead>{t(($) => $.columnToken)}</TableHead>
                  <TableHead className="text-right">{t(($) => $.columnUnits)}</TableHead>
                  <TableHead className="text-right">{t(($) => $.columnAvgPrice)}</TableHead>
                  <TableHead className="text-right">{t(($) => $.columnValue)}</TableHead>
                  <TableHead className="text-right">{t(($) => $.columnPnl)}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {positions.map((p) => (
                  <TableRow key={p.symbol}>
                    <TableCell className="font-medium">{p.symbol}</TableCell>
                    <TableCell className="text-right">
                      {p.units.toLocaleString('fr-FR', { maximumFractionDigits: 4 })}
                    </TableCell>
                    <TableCell className="text-right">
                      {p.avgBuyPrice != null ? formatCurrency(p.avgBuyPrice) : '—'}
                    </TableCell>
                    <TableCell className="text-right">
                      {p.currentValue != null ? formatCurrency(p.currentValue) : '—'}
                    </TableCell>
                    <TableCell className={`text-right ${p.pnl < 0 ? 'text-red-500' : 'text-green-500'}`}>
                      {formatCurrency(p.pnl)}
                      {p.pnlRatio != null ? (
                        <span className="text-muted-foreground text-xs"> ({formatPercent(p.pnlRatio)})</span>
                      ) : null}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </UiCard>
      ) : null}

      <FimsUiAddressBook account={account} userId={member.id} />

      <UiCard title={t(($) => $.transactionsTitle)}>
        {transactions.isLoading ? (
          <UiLoader />
        ) : (
          <div className="max-h-96 overflow-y-auto">
            <Table>
              <TableHeader className="sticky top-0 bg-background">
                <TableRow>
                  <TableHead>{t(($) => $.columnDate)}</TableHead>
                  <TableHead>{t(($) => $.columnToken)}</TableHead>
                  <TableHead>{t(($) => $.columnType)}</TableHead>
                  <TableHead className="text-right">{t(($) => $.columnAmount)}</TableHead>
                  <TableHead className="text-right">{t(($) => $.columnCost)}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(transactions.data ?? []).map((tx) => (
                  <TableRow key={tx.id}>
                    <TableCell>{formatDate(tx.date)}</TableCell>
                    <TableCell>{tx.token ?? '—'}</TableCell>
                    <TableCell>{tx.donationTarget ? `${tx.type} → ${tx.donationTarget}` : (tx.type ?? '—')}</TableCell>
                    <TableCell className="text-right">{tx.amount ?? '—'}</TableCell>
                    <TableCell className="text-right">{formatCurrency(tx.cost)}</TableCell>
                  </TableRow>
                ))}
                {transactions.data?.length === 0 ? (
                  <TableRow>
                    <TableCell className="text-center text-muted-foreground" colSpan={5}>
                      {t(($) => $.transactionsEmpty)}
                    </TableCell>
                  </TableRow>
                ) : null}
              </TableBody>
            </Table>
          </div>
        )}
      </UiCard>
    </div>
  )
}
