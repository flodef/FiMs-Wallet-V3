import type { Address } from '@solana/kit'
import type { Account } from '@workspace/db/account/account'
import { useNetworkActive } from '@workspace/db-react/use-network-active'
import { PortfolioUiAccountButtons } from '@workspace/feature-portfolio/ui/portfolio-ui-account-buttons'
import { useTranslation } from '@workspace/i18n'
import { formatNumber } from '@workspace/i18n/format'
import { useGetBalance } from '@workspace/solana-client-react/use-get-balance'
import { Alert, AlertDescription, AlertTitle } from '@workspace/ui/components/alert'
import { Badge } from '@workspace/ui/components/badge'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@workspace/ui/components/table'
import { UiCard } from '@workspace/ui/components/ui-card'
import { UiLoader } from '@workspace/ui/components/ui-loader'
import { UiTextCopyIcon } from '@workspace/ui/components/ui-text-copy-icon'
import { useMemo, useState } from 'react'
import { useFimsMember, useFimsMemberSummary, useFimsTokens, useFimsTransactions } from './data-access/use-fims.tsx'
import { useFimsCurrency } from './data-access/use-fims-currency.tsx'
import { useFimsNewTransactions } from './data-access/use-fims-new-transactions.tsx'
import { useSnsDomain } from './data-access/use-sns-domain.tsx'
import { getFimsTontineRate } from './fims-fee-config.ts'
import { formatPercent } from './fims-format.ts'
import { computeFimsPositions } from './fims-positions.ts'
import { getFimsTransactionType } from './fims-transaction-type.ts'
import { groupFimsTransactions } from './fims-tx-groups.ts'
import { FimsUiAddressBook } from './fims-ui-address-book.tsx'
import { FimsUiCurrencySelect } from './fims-ui-currency-select.tsx'
import { FimsUiMemberClaim } from './fims-ui-member-claim.tsx'
import { FimsUiMemberDirectory } from './fims-ui-member-directory.tsx'
import { FimsUiMemberSummary } from './fims-ui-member-summary.tsx'
import { FimsUiProfileEdit } from './fims-ui-profile-edit.tsx'
import { FimsUiRebalance } from './fims-ui-rebalance.tsx'
import { FimsUiTxExplorer } from './fims-ui-tx-explorer.tsx'

export function FimsFeatureMember({ account }: { account: Account }) {
  const address = account.publicKey
  const { t } = useTranslation('fims')
  const { format } = useFimsCurrency()
  const { isLoading, member } = useFimsMember(address, account)
  const snsDomain = useSnsDomain(address)
  const summary = useFimsMemberSummary(member?.id, account)
  const transactions = useFimsTransactions(member ? { userId: member.id } : undefined, account, !!member)
  const tokens = useFimsTokens()
  const positions = useMemo(
    () => computeFimsPositions(transactions.data ?? [], tokens.data ?? []),
    [transactions.data, tokens.data],
  )
  useFimsNewTransactions(member?.id, transactions.data)
  // Position-row click drills into the matching ledger rows below.
  const [drillToken, setDrillToken] = useState<null | string>(null)
  const donations = useMemo(() => {
    const list = (transactions.data ?? []).filter((tx) => ['donation', 'tontine'].includes(getFimsTransactionType(tx)))
    return { count: list.length, total: list.reduce((sum, tx) => sum + (tx.movement ?? 0), 0) }
  }, [transactions.data])
  const txGroups = useMemo(() => groupFimsTransactions(transactions.data ?? []), [transactions.data])

  if (isLoading) return <UiLoader />

  if (!member) {
    return <FimsUiMemberClaim account={account} />
  }

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
        <p className="mb-3 flex items-center gap-1 break-all font-mono text-muted-foreground text-xs" title={address}>
          {snsDomain.data ?? address}
          <UiTextCopyIcon text={address} toast={t(($) => $.profileAddressCopied)} />
        </p>
        <FimsUiMemberSummary summary={summary.data} />
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
                  <TableRow
                    className={`cursor-pointer ${drillToken === p.symbol ? 'bg-muted/60' : ''}`}
                    key={p.symbol}
                    onClick={() => setDrillToken(drillToken === p.symbol ? null : p.symbol)}
                    title={t(($) => $.positionsDrillHint)}
                  >
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

      <FimsUiMemberDirectory member={member} />

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
          <FimsUiTxExplorer
            activeToken={drillToken}
            format={format}
            groups={txGroups}
            onTokenFilterChange={setDrillToken}
            tokens={tokens.data ?? []}
          />
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
