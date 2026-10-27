import { useTranslation } from '@workspace/i18n'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@workspace/ui/components/table'
import { UiCard } from '@workspace/ui/components/ui-card'
import { UiLoader } from '@workspace/ui/components/ui-loader'
import { useMemo } from 'react'
import { useFimsDashboard, useFimsHistoric, useFimsPrices, useFimsTokens } from './data-access/use-fims.tsx'
import { useFimsCurrency } from './data-access/use-fims-currency.tsx'
import { formatPercent } from './fims-format.ts'
import { computePeriodReturns, computeRealizedAnnualRates, fimsPriceKey } from './fims-performance.ts'
import { FimsUiCurrencySelect } from './fims-ui-currency-select.tsx'
import { FimsUiHistoricChart } from './fims-ui-historic-chart.tsx'
import { FimsUiTokenChart } from './fims-ui-token-chart.tsx'

export function FimsFeatureCommunity() {
  const { t } = useTranslation('fims')
  const { format } = useFimsCurrency()
  const dashboard = useFimsDashboard()
  const tokens = useFimsTokens()
  const historic = useFimsHistoric()
  const latest = historic.data?.at(-1)
  const prices = useFimsPrices()
  const perf30d = useMemo(() => computePeriodReturns(prices.data ?? [], 30), [prices.data])
  const perf1y = useMemo(() => computePeriodReturns(prices.data ?? [], 365), [prices.data])
  const realRates = useMemo(() => computeRealizedAnnualRates(prices.data ?? []), [prices.data])

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
        <p className="pt-2 text-muted-foreground text-xs">{t(($) => $.communityDisclaimer)}</p>
      </UiCard>

      {historic.data && historic.data.length > 1 ? (
        <UiCard title={t(($) => $.perfTitle)}>
          <FimsUiHistoricChart
            format={format}
            points={historic.data.map((point) => ({
              date: point.date,
              invested: point.invested,
              total: point.treasury,
            }))}
          />
        </UiCard>
      ) : null}

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
                  <TableHead className="text-right">{t(($) => $.columnPerf)}</TableHead>
                  <TableHead className="text-right">{t(($) => $.columnPerfYear)}</TableHead>
                  <TableHead className="text-right">{t(($) => $.columnYield)}</TableHead>
                  <TableHead className="text-right">{t(($) => $.columnRealRate)}</TableHead>
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
                      <SignedPercent value={perf30d.get(fimsPriceKey(token))} />
                    </TableCell>
                    <TableCell className="text-right">
                      <SignedPercent value={perf1y.get(fimsPriceKey(token))} />
                    </TableCell>
                    <TableCell className="text-right">
                      {token.yearlyYield != null ? formatPercent(token.yearlyYield) : '—'}
                    </TableCell>
                    <TableCell className="text-right">
                      <SignedPercent value={realRates.get(fimsPriceKey(token))} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </UiCard>

      <FimsUiTokenChart />
    </div>
  )
}

function SignedPercent({ value }: { value: number | undefined }) {
  if (value == null) return '—'
  return (
    <span className={value >= 0 ? 'text-green-600 dark:text-green-400' : 'text-red-500'}>{formatPercent(value)}</span>
  )
}
