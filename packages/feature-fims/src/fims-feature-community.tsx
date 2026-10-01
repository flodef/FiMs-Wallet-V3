import { useTranslation } from '@workspace/i18n'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@workspace/ui/components/table'
import { UiCard } from '@workspace/ui/components/ui-card'
import { UiLoader } from '@workspace/ui/components/ui-loader'
import {
  useFimsDashboard,
  useFimsHistoric,
  useFimsTokens,
  useFimsUserHistoric,
  useFimsUsers,
} from './data-access/use-fims.tsx'
import { useFimsCurrency } from './data-access/use-fims-currency.tsx'
import { formatPercent } from './fims-format.ts'
import { FimsUiCurrencySelect } from './fims-ui-currency-select.tsx'

export function FimsFeatureCommunity() {
  const { t } = useTranslation('fims')
  const { format } = useFimsCurrency()
  const dashboard = useFimsDashboard()
  const tokens = useFimsTokens()
  const historic = useFimsHistoric()
  const latest = historic.data?.at(-1)
  const users = useFimsUsers()
  const tontineId = (users.data ?? []).find((u) => u.name.toLowerCase() === 'tontine')?.id
  const tontineHistoric = useFimsUserHistoric(tontineId)
  const tontineLatest = tontineHistoric.data?.at(-1)

  return (
    <div className="space-y-4">
      <UiCard action={<FimsUiCurrencySelect />} title={t(($) => $.dashboardTitle)}>
        {dashboard.isLoading ? (
          <UiLoader />
        ) : (
          <div className="grid grid-cols-2 gap-4 md:grid-cols-3">
            {(dashboard.data ?? []).map((metric) => (
              <div key={metric.label}>
                <div className="text-muted-foreground text-xs">{metric.label}</div>
                <div className="font-semibold">{format(metric.value)}</div>
                {metric.ratio != null ? (
                  <div className="text-muted-foreground text-xs">{formatPercent(metric.ratio)}</div>
                ) : null}
              </div>
            ))}
          </div>
        )}
        {latest ? (
          <p className="pt-2 text-muted-foreground text-xs">
            {t(($) => $.treasuryLabel)}: {latest.treasury != null ? format(latest.treasury) : '—'} ·{' '}
            {t(($) => $.investedLabel)}: {format(latest.invested)}
          </p>
        ) : null}
      </UiCard>

      <UiCard title={t(($) => $.tokensTitle)}>
        {tokens.isLoading ? (
          <UiLoader />
        ) : (
          <div className="max-h-96 overflow-y-auto">
            <Table>
              <TableHeader className="sticky top-0 bg-background">
                <TableRow>
                  <TableHead>{t(($) => $.columnToken)}</TableHead>
                  <TableHead className="text-right">{t(($) => $.columnValue)}</TableHead>
                  <TableHead className="text-right">{t(($) => $.columnYield)}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(tokens.data ?? []).map((token) => (
                  <TableRow key={token.symbol}>
                    <TableCell>
                      <div className="font-medium">{token.symbol}</div>
                      <div className="text-muted-foreground text-xs">{token.label}</div>
                    </TableCell>
                    <TableCell className="text-right">{token.value != null ? format(token.value) : '—'}</TableCell>
                    <TableCell className="text-right">
                      {token.yearlyYield != null ? formatPercent(token.yearlyYield) : '—'}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </UiCard>

      {tontineLatest ? (
        <UiCard title={t(($) => $.tontineTitle)}>
          <div className="grid grid-cols-2 gap-4 text-center">
            <div>
              <div className="text-muted-foreground text-xs">{t(($) => $.tontineInvested)}</div>
              <div className="font-semibold">{format(tontineLatest.invested)}</div>
            </div>
            <div>
              <div className="text-muted-foreground text-xs">{t(($) => $.tontineValue)}</div>
              <div className="font-semibold">{tontineLatest.total != null ? format(tontineLatest.total) : '—'}</div>
            </div>
          </div>
        </UiCard>
      ) : null}
    </div>
  )
}
