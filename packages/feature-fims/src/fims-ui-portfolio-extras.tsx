import { useTranslation } from '@workspace/i18n'
import { formatNumber } from '@workspace/i18n/format'
import { Button } from '@workspace/ui/components/button'
import { UiIcon } from '@workspace/ui/components/ui-icon'
import { useMemo, useState } from 'react'
// biome-ignore lint/suspicious/noDeprecatedImports: Cell is the current PieChart slice API in this recharts version
import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from 'recharts'
import { useFimsCurrency } from './data-access/use-fims-currency.tsx'
import type { FimsMemberSummary, FimsToken, FimsUserHistoricPoint } from './fims-api.ts'
import { formatPercent } from './fims-format.ts'
import { FimsUiHistoricChart } from './fims-ui-historic-chart.tsx'

const DONUT_COLORS = ['#6366f1', '#22c55e', '#f59e0b', '#ef4444', '#8b5cf6', '#06b6d4', '#ec4899']

// v1 portfolio extras: gains bar, allocation donut, risk gauge and the
// invested-vs-total performance chart, plus the privacy toggle that blurs
// every amount. All data comes from the member summary + rebuilt history.
export function FimsUiPortfolioExtras({
  historic,
  summary,
  tokens,
}: {
  historic: FimsUserHistoricPoint[]
  summary: FimsMemberSummary
  tokens: FimsToken[]
}) {
  const { t } = useTranslation('fims')
  const { format } = useFimsCurrency()
  const [hidden, setHidden] = useState(false)
  const money = (value: number) => (hidden ? '•••' : format(value))

  const volatilityBySymbol = useMemo(
    () => new Map(tokens.map((token) => [token.symbol, token.volatility ?? 0])),
    [tokens],
  )
  const heldPositions = useMemo(() => summary.positions.filter((position) => position.units > 0), [summary.positions])
  const donutData = heldPositions.map((position) => ({ name: position.symbol, value: position.value }))
  const totalValue = donutData.reduce((sum, slice) => sum + slice.value, 0)
  const weightedVolatility =
    totalValue > 0
      ? heldPositions.reduce(
          (sum, position) => sum + (volatilityBySymbol.get(position.symbol) ?? 0) * position.value,
          0,
        ) / totalValue
      : null

  const invested = Math.max(0, summary.invested)
  const gains = Math.max(0, summary.profit)
  const loss = Math.min(0, summary.profit)
  const barTotal = invested + gains - loss || 1

  // v1 empty-wallet alert: a member holding no protocol position gets the
  // FiMs tokens suggested as the entry point.
  if (heldPositions.length === 0) {
    return (
      <div className="border-t pt-4">
        <div className="rounded-md border border-yellow-500/40 bg-yellow-500/10 p-3 text-sm">
          <p className="font-medium">{t(($) => $.emptyWalletTitle)}</p>
          <p className="text-muted-foreground text-xs">
            {t(($) => $.emptyWalletBody, { tokens: tokens.map((token) => token.symbol).join(', ') })}
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-4 border-t pt-4">
      <div className="flex items-center justify-end">
        <Button onClick={() => setHidden((value) => !value)} size="icon" variant="ghost">
          <UiIcon icon={hidden ? 'eyeOff' : 'watch'} />
          <span className="sr-only">{hidden ? t(($) => $.privacyShow) : t(($) => $.privacyHide)}</span>
        </Button>
      </div>

      {/* Gains bar: invested vs profit/loss shares of the position. */}
      <div className="space-y-1">
        <div className="flex h-3 w-full overflow-hidden rounded-full bg-muted">
          <div className="bg-muted-foreground/60" style={{ width: `${(invested / barTotal) * 100}%` }} />
          {gains > 0 ? <div className="bg-green-500" style={{ width: `${(gains / barTotal) * 100}%` }} /> : null}
          {loss < 0 ? <div className="bg-red-500" style={{ width: `${(-loss / barTotal) * 100}%` }} /> : null}
        </div>
        <div className="flex flex-wrap justify-between text-muted-foreground text-xs">
          <span>
            {t(($) => $.labelInvested)}: {money(invested)}
          </span>
          <span className={summary.profit < 0 ? 'text-red-500' : 'text-green-500'}>
            {t(($) => $.labelPnl)}: {money(summary.profit)}
            {summary.profitRatio != null ? ` (${formatPercent(summary.profitRatio)})` : ''}
          </span>
          {summary.yearlyRate != null ? (
            <span>
              {t(($) => $.summaryYearlyYield)}: {formatPercent(summary.yearlyRate)}
            </span>
          ) : null}
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        {donutData.length ? (
          <div className="space-y-1">
            <div className="text-center text-muted-foreground text-xs">{t(($) => $.allocationTitle)}</div>
            <div className="h-40 w-full">
              <ResponsiveContainer height="100%" width="100%">
                <PieChart>
                  <Pie
                    data={donutData}
                    dataKey="value"
                    innerRadius="55%"
                    nameKey="name"
                    outerRadius="80%"
                    paddingAngle={2}
                  >
                    {donutData.map((slice, index) => (
                      <Cell fill={DONUT_COLORS[index % DONUT_COLORS.length] ?? '#6366f1'} key={slice.name} />
                    ))}
                  </Pie>
                  <Tooltip formatter={(value) => (typeof value === 'number' ? money(value) : value)} />
                </PieChart>
              </ResponsiveContainer>
            </div>
            <div className="flex flex-wrap justify-center gap-x-3 gap-y-1 text-xs">
              {donutData.map((slice, index) => (
                <span className="inline-flex items-center gap-1" key={slice.name}>
                  <span
                    className="inline-block size-2 rounded-full"
                    style={{ background: DONUT_COLORS[index % DONUT_COLORS.length] ?? '#6366f1' }}
                  />
                  {slice.name} {hidden ? '' : `(${formatPercent(totalValue > 0 ? slice.value / totalValue : 0)})`}
                </span>
              ))}
            </div>
          </div>
        ) : null}

        {weightedVolatility !== null ? <FimsUiRiskGauge hidden={hidden} volatility={weightedVolatility} /> : null}
      </div>

      {historic.length > 1 ? (
        <div className="space-y-1">
          <div className="text-center text-muted-foreground text-xs">{t(($) => $.perfTitle)}</div>
          <FimsUiHistoricChart format={money} points={historic} />
        </div>
      ) : null}
    </div>
  )
}

// Semicircle gauge mapping portfolio-weighted volatility (0–1) onto the v1
// five-band risk scale.
function FimsUiRiskGauge({ hidden, volatility }: { hidden: boolean; volatility: number }) {
  const { t } = useTranslation('fims')
  const bands = [
    { color: '#22c55e', label: t(($) => $.riskVeryLow), max: 0.2 },
    { color: '#84cc16', label: t(($) => $.riskLow), max: 0.4 },
    { color: '#f59e0b', label: t(($) => $.riskMedium), max: 0.6 },
    { color: '#f97316', label: t(($) => $.riskHigh), max: 0.8 },
    { color: '#ef4444', label: t(($) => $.riskVeryHigh), max: 1 },
  ]
  const clamped = Math.min(1, Math.max(0, volatility))
  const band = bands.find((item) => clamped <= item.max) ?? bands.at(-1)
  const angle = -90 + clamped * 180
  return (
    <div className="space-y-1">
      <div className="text-center text-muted-foreground text-xs">{t(($) => $.riskTitle)}</div>
      <svg className="mx-auto" height="90" role="img" viewBox="0 0 200 105" width="180">
        <title>{t(($) => $.riskTitle)}</title>
        {bands.map((item, index) => {
          const from = index === 0 ? 0 : (bands[index - 1]?.max ?? 0)
          const a0 = Math.PI - from * Math.PI
          const a1 = Math.PI - item.max * Math.PI
          const x0 = 100 + 80 * Math.cos(a0)
          const y0 = 100 - 80 * Math.sin(a0)
          const x1 = 100 + 80 * Math.cos(a1)
          const y1 = 100 - 80 * Math.sin(a1)
          return (
            <path
              d={`M ${x0} ${y0} A 80 80 0 0 1 ${x1} ${y1}`}
              fill="none"
              key={item.label}
              stroke={item.color}
              strokeWidth="14"
            />
          )
        })}
        <line
          stroke="var(--foreground)"
          strokeWidth="3"
          transform={`rotate(${angle} 100 100)`}
          x1="100"
          x2="100"
          y1="100"
          y2="32"
        />
        <circle cx="100" cy="100" fill="var(--foreground)" r="5" />
      </svg>
      <div className="text-center font-medium text-sm" style={{ color: band?.color }}>
        {band?.label} {!hidden ? `(${formatNumber(volatility, { maximumFractionDigits: 2 })})` : ''}
      </div>
    </div>
  )
}
