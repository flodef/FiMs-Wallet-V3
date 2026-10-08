import type { Address } from '@solana/kit'
import type { Account } from '@workspace/db/account/account'
import { useNetworkActive } from '@workspace/db-react/use-network-active'
import { PortfolioUiAccountButtons } from '@workspace/feature-portfolio/ui/portfolio-ui-account-buttons'
import { useTranslation } from '@workspace/i18n'
import { useGetBalance } from '@workspace/solana-client-react/use-get-balance'
import { Alert, AlertDescription, AlertTitle } from '@workspace/ui/components/alert'
import { Badge } from '@workspace/ui/components/badge'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@workspace/ui/components/table'
import { UiCard } from '@workspace/ui/components/ui-card'
import { UiLoader } from '@workspace/ui/components/ui-loader'
import { useMemo } from 'react'
import { useFimsMember, useFimsTokens, useFimsTransactions, useFimsUserHistoric } from './data-access/use-fims.tsx'
import { useFimsCurrency } from './data-access/use-fims-currency.tsx'
import { useFimsNewTransactions } from './data-access/use-fims-new-transactions.tsx'
import { useSnsDomain } from './data-access/use-sns-domain.tsx'
import { getFimsTontineRate } from './fims-fee-config.ts'
import { formatDate, formatPercent } from './fims-format.ts'
import { annualizedRate } from './fims-performance.ts'
import { computeFimsPositions } from './fims-positions.ts'
import { getFimsTransactionType } from './fims-transaction-type.ts'
import { FimsTxTypeLabel } from './fims-tx-type-label.tsx'
import { FimsUiAddressBook } from './fims-ui-address-book.tsx'
import { FimsUiCurrencySelect } from './fims-ui-currency-select.tsx'
import { FimsUiMemberClaim } from './fims-ui-member-claim.tsx'
import { FimsUiProfileEdit } from './fims-ui-profile-edit.tsx'
import { FimsUiRatioBadges } from './fims-ui-ratio-badges.tsx'
import { FimsUiRebalance } from './fims-ui-rebalance.tsx'

export function FimsFeatureMember({ account }: { account: Account }) {
  const address = account.publicKey
  const { t } = useTranslation('fims')
  const { format } = useFimsCurrency()
  const { isLoading, member } = useFimsMember(address, account)
  const snsDomain = useSnsDomain(address)
  const historic = useFimsUserHistoric(member?.id, account)
  const transactions = useFimsTransactions(member ? { userId: member.id } : undefined, account)
  const tokens = useFimsTokens()
  const positions = useMemo(
    () => computeFimsPositions(transactions.data ?? [], tokens.data ?? []),
    [transactions.data, tokens.data],
  )
  useFimsNewTransactions(member?.id, transactions.data)
  const donations = useMemo(() => {
    const list = (transactions.data ?? []).filter((tx) => ['donation', 'tontine'].includes(getFimsTransactionType(tx)))
    return { count: list.length, total: list.reduce((sum, tx) => sum + (tx.movement ?? 0), 0) }
  }, [transactions.data])

  if (isLoading) return <UiLoader />

  if (!member) {
    return <FimsUiMemberClaim account={account} />
  }

  const latest = historic.data?.at(-1)
  const previous = historic.data?.at(-2)
  const first = historic.data?.at(0)
  const pnl = latest?.total != null ? latest.total - latest.invested : null
  const pnlRatio = latest && latest.invested > 0 && pnl != null ? pnl / latest.invested : null
  const dayRatio =
    latest?.total != null && previous?.total != null && previous.total > 0
      ? (latest.total - previous.total) / previous.total
      : null
  // Realized rate: what the position actually earned, annualized over the
  // real holding period — unlike a projected current rate. The whole invested
  // amount is treated as held since the first historic entry.
  const realRate =
    first && latest
      ? annualizedRate({ date: first.date, value: latest.invested }, { date: latest.date, value: latest.total ?? 0 })
      : undefined
  const tontineRate = getFimsTontineRate()
  const remainingToDonate = pnl != null && pnl > 0 ? Math.max(0, pnl * tontineRate - donations.total) : null

  return (
    <div className="space-y-4">
      <PortfolioUiAccountButtons />
      <FimsNoSolWarning address={address} />
      <UiCard
        action={
          <div className="flex gap-2">
            <FimsUiCurrencySelect />
            {member.isPro ? <Badge>{t(($) => $.badgePro)}</Badge> : null}
            <Badge variant="outline">{member.isPublic ? t(($) => $.badgePublic) : t(($) => $.badgePrivate)}</Badge>
          </div>
        }
        title={member.name}
      >
        <p className="mb-3 font-mono text-muted-foreground text-xs" title={address}>
          {snsDomain.data ?? address}
        </p>
        <div className="grid grid-cols-3 gap-4 text-center">
          <div>
            <div className="text-muted-foreground text-xs">{t(($) => $.labelInvested)}</div>
            <div className="font-semibold">{latest ? format(latest.invested) : '—'}</div>
          </div>
          <div>
            <div className="text-muted-foreground text-xs">{t(($) => $.labelCurrentValue)}</div>
            <div className="font-semibold">{latest?.total != null ? format(latest.total) : '—'}</div>
          </div>
          <div>
            <div className="text-muted-foreground text-xs">{t(($) => $.labelPnl)}</div>
            <div className={pnl != null && pnl < 0 ? 'font-semibold text-red-500' : 'font-semibold text-green-500'}>
              {pnl != null ? format(pnl) : '—'}
            </div>
            <FimsUiRatioBadges dayRatio={dayRatio} pnlRatio={pnlRatio} />
            {realRate != null ? (
              <div className="text-muted-foreground text-xs">
                {t(($) => $.labelRealRate)}: {formatPercent(realRate)}
              </div>
            ) : null}
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
                    <TableCell className="text-right">{p.avgBuyPrice != null ? format(p.avgBuyPrice) : '—'}</TableCell>
                    <TableCell className="text-right">
                      {p.currentValue != null ? format(p.currentValue) : '—'}
                    </TableCell>
                    <TableCell className={`text-right ${p.pnl < 0 ? 'text-red-500' : 'text-green-500'}`}>
                      {format(p.pnl)}
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

      <FimsUiProfileEdit account={account} member={member} />

      <FimsUiAddressBook account={account} userId={member.id} />

      {donations.count > 0 || remainingToDonate ? (
        <UiCard title={t(($) => $.donationsTitle)}>
          <div className="grid grid-cols-3 gap-4 text-center">
            <div>
              <div className="text-muted-foreground text-xs">{t(($) => $.donationsTotal)}</div>
              <div className="font-semibold text-pink-500">{format(donations.total)}</div>
            </div>
            <div>
              <div className="font-semibold">{t(($) => $.donationsCount, { count: donations.count })}</div>
            </div>
            <div>
              <div className="text-muted-foreground text-xs">{t(($) => $.donationsRemaining)}</div>
              <div className="font-semibold">{remainingToDonate ? format(remainingToDonate) : '—'}</div>
            </div>
          </div>
          {pnl != null && pnl > 0 ? (
            <div className="mt-4">
              <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
                <div
                  className="h-full rounded-full bg-pink-500 transition-all"
                  style={{ width: `${Math.min(100, (donations.total / (pnl * tontineRate)) * 100)}%` }}
                />
              </div>
              <p className="mt-1 text-center text-muted-foreground text-xs">
                {t(($) => $.donationsProgress, {
                  rate: tontineRate * 100,
                  ratio: formatPercent(donations.total / (pnl * tontineRate)),
                })}
              </p>
            </div>
          ) : null}
          {remainingToDonate ? (
            <p className="mt-3 text-muted-foreground text-xs">
              {t(($) => $.donationsRemainingHint, { rate: tontineRate * 100 })}
            </p>
          ) : null}
        </UiCard>
      ) : null}

      <FimsUiRebalance account={account} member={member} positions={positions} />

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
                    <TableCell>
                      <FimsTxTypeLabel transaction={tx} />
                      {tx.donationTarget
                        ? ` → ${tx.donationTarget}${tx.donationAmount != null ? ` (${tx.donationAmount} ${tx.token ?? ''})` : ''}`
                        : ''}
                    </TableCell>
                    <TableCell className="text-right">{tx.amount ?? '—'}</TableCell>
                    <TableCell className="text-right">{format(tx.cost)}</TableCell>
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

function FimsNoSolWarning({ address }: { address: Address }) {
  const { t } = useTranslation('fims')
  const network = useNetworkActive()
  const balance = useGetBalance({ address, network })

  if (balance.isLoading || !balance.data || balance.data.value > 0n) return null

  return (
    <Alert variant="destructive">
      <AlertTitle>{t(($) => $.noSolTitle)}</AlertTitle>
      <AlertDescription>{t(($) => $.noSolDescription)}</AlertDescription>
    </Alert>
  )
}
