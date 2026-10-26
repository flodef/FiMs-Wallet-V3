import type { Address } from '@solana/kit'
import type { Account } from '@workspace/db/account/account'
import { useNetworkActive } from '@workspace/db-react/use-network-active'
import { ExplorerUiTxExternalLink } from '@workspace/feature-explorer/ui/explorer-ui-tx-external-link'
import { PortfolioUiAccountButtons } from '@workspace/feature-portfolio/ui/portfolio-ui-account-buttons'
import { useTranslation } from '@workspace/i18n'
import { formatNumber } from '@workspace/i18n/format'
import { useGetBalance } from '@workspace/solana-client-react/use-get-balance'
import { Alert, AlertDescription, AlertTitle } from '@workspace/ui/components/alert'
import { Badge } from '@workspace/ui/components/badge'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@workspace/ui/components/table'
import { UiCard } from '@workspace/ui/components/ui-card'
import { UiIcon } from '@workspace/ui/components/ui-icon'
import type { UiIconName } from '@workspace/ui/components/ui-icon-map'
import { UiLoader } from '@workspace/ui/components/ui-loader'
import { useMemo } from 'react'
import { useFimsMember, useFimsTokens, useFimsTransactions, useFimsUserHistoric } from './data-access/use-fims.tsx'
import { useFimsCurrency } from './data-access/use-fims-currency.tsx'
import { useFimsNewTransactions } from './data-access/use-fims-new-transactions.tsx'
import { useSnsDomain } from './data-access/use-sns-domain.tsx'
import type { FimsTransaction, FimsTransactionType } from './fims-api.ts'
import { getFimsTontineRate } from './fims-fee-config.ts'
import { formatDate, formatPercent } from './fims-format.ts'
import { annualizedRate } from './fims-performance.ts'
import { computeFimsPositions } from './fims-positions.ts'
import { getFimsTransactionType } from './fims-transaction-type.ts'
import { groupFimsTransactions } from './fims-tx-groups.ts'
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
  const transactions = useFimsTransactions(member ? { userId: member.id } : undefined, account, !!member)
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
  const txGroups = useMemo(() => groupFimsTransactions(transactions.data ?? []), [transactions.data])

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
                    <TableCell className="text-right">{formatNumber(p.units, { maximumFractionDigits: 4 })}</TableCell>
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

      {donations.count > 0 ? (
        <UiCard title={t(($) => $.donationsTitle)}>
          <div className="grid grid-cols-2 gap-4 text-center">
            <div>
              <div className="text-muted-foreground text-xs">{t(($) => $.donationsTotal)}</div>
              <div className="font-semibold text-pink-500">{format(donations.total)}</div>
            </div>
            <div>
              <div className="font-semibold">{t(($) => $.donationsCount, { count: donations.count })}</div>
            </div>
          </div>
          <p className="mt-3 text-muted-foreground text-xs">
            {t(($) => $.donationsCarveHint, { rate: getFimsTontineRate() * 100 })}
          </p>
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
                  <TableHead>{t(($) => $.columnType)}</TableHead>
                  <TableHead className="text-right">{t(($) => $.columnAmount)}</TableHead>
                  <TableHead className="text-right">{t(($) => $.columnValue)}</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {txGroups.map((group) => (
                  <FimsTxRow format={format} group={group} key={group.legs[0].id} />
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

// Type → icon for the transaction list: in/out arrows for capital flows,
// refresh for conversions, coins for gifts.
const TX_ICONS: Record<FimsTransactionType, UiIconName> = {
  cex_in: 'arrowDown',
  cex_out: 'arrowUp',
  conversion: 'refresh',
  deposit: 'arrowDown',
  donation: 'handCoins',
  payment: 'coins',
  tontine: 'handCoins',
  withdrawal: 'arrowUp',
}

const signedUnits = (tx: FimsTransaction): string =>
  tx.amount == null ? '—' : `${formatNumber(Number(tx.amount), { maximumFractionDigits: 6 })} ${tx.token ?? ''}`

function FimsTxRow({
  format,
  group,
}: {
  format: (value: number) => string
  group: { legs: [FimsTransaction, ...FimsTransaction[]] }
}) {
  const [first] = group.legs
  const type = getFimsTransactionType(first)
  const signature = group.legs.find((leg) => leg.signature)?.signature
  return (
    <TableRow>
      <TableCell className="whitespace-nowrap">{formatDate(first.date)}</TableCell>
      <TableCell>
        <span className="inline-flex items-center gap-1">
          <UiIcon className="size-3 text-muted-foreground" icon={TX_ICONS[type] ?? 'activity'} />
          <FimsTxTypeLabel transaction={first} />
        </span>
        {first.donationTarget ? (
          <div className="text-muted-foreground text-xs">
            → {first.donationTarget}
            {first.donationAmount != null
              ? ` (${formatNumber(Number(first.donationAmount))} ${first.token ?? ''})`
              : ''}
          </div>
        ) : null}
      </TableCell>
      <TableCell className="text-right">
        {group.legs.map((leg) => (
          <div className="whitespace-nowrap" key={leg.id}>
            {signedUnits(leg)}
          </div>
        ))}
      </TableCell>
      <TableCell className="text-right">
        {group.legs.map((leg) => (
          <div className="whitespace-nowrap" key={leg.id}>
            <span className={leg.movement < 0 ? 'text-red-500' : 'text-green-500'}>{format(leg.movement)}</span>
            {leg.cost !== 0 ? <div className="text-muted-foreground text-xs">{format(leg.cost)}</div> : null}
          </div>
        ))}
      </TableCell>
      <TableCell>
        {signature ? (
          <ExplorerUiTxExternalLink className="text-muted-foreground" signature={signature}>
            <UiIcon className="size-3" icon="explorer" />
          </ExplorerUiTxExternalLink>
        ) : null}
      </TableCell>
    </TableRow>
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
