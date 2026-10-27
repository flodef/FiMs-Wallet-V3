import { useTranslation } from '@workspace/i18n'
import { formatNumber } from '@workspace/i18n/format'
import { Badge } from '@workspace/ui/components/badge'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@workspace/ui/components/dialog'
import { UiLoader } from '@workspace/ui/components/ui-loader'
import { ellipsify } from '@workspace/ui/lib/ellipsify'
import { useMemo, useState } from 'react'
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { useFimsPrices } from './data-access/use-fims.tsx'
import { useFimsCurrency } from './data-access/use-fims-currency.tsx'
import type { FimsToken } from './fims-api.ts'
import { formatDate, formatPercent } from './fims-format.ts'
import { fimsPriceKey } from './fims-performance.ts'

// v1 token periods: the price feed is daily, so a "day" window is the last
// two points, a year is the whole series.
const PERIODS = [
  { key: 'day', points: 2 },
  { key: 'week', points: 8 },
  { key: 'month', points: 31 },
  { key: 'quarter', points: 92 },
  { key: 'year', points: Number.POSITIVE_INFINITY },
] as const
type PeriodKey = (typeof PERIODS)[number]['key']

const RISK_BANDS: { label: 'riskHigh' | 'riskLow' | 'riskMedium' | 'riskVeryHigh' | 'riskVeryLow'; max: number }[] = [
  { label: 'riskVeryLow', max: 0.2 },
  { label: 'riskLow', max: 0.4 },
  { label: 'riskMedium', max: 0.6 },
  { label: 'riskHigh', max: 0.8 },
  { label: 'riskVeryHigh', max: 1.01 },
]

// v1 TokenInfo drawer: price, yield, risk band, inception price/date,
// description and the single-token price chart with a period selector.
export function FimsUiTokenInfo({
  onOpenChange,
  open,
  token,
}: {
  onOpenChange: (open: boolean) => void
  open: boolean
  token: FimsToken | null
}) {
  const { t } = useTranslation('fims')
  const { format } = useFimsCurrency()
  const prices = useFimsPrices(token ? fimsPriceKey(token) : undefined)
  const [period, setPeriod] = useState<PeriodKey>('month')
  const periodLabels: Record<PeriodKey, string> = {
    day: t(($) => $.tokenInfoPeriod_day),
    month: t(($) => $.tokenInfoPeriod_month),
    quarter: t(($) => $.tokenInfoPeriod_quarter),
    week: t(($) => $.tokenInfoPeriod_week),
    year: t(($) => $.tokenInfoPeriod_year),
  }

  const points = useMemo(() => {
    const all = prices.data ?? []
    const count = PERIODS.find((item) => item.key === period)?.points ?? 31
    return all.slice(-count)
  }, [prices.data, period])
  const rising = points.length > 1 && (points.at(-1)?.price ?? 0) >= (points[0]?.price ?? 0)

  if (!token) return null
  const risk = RISK_BANDS.find((band) => (token.volatility ?? 0) < band.max)

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {token.symbol} <span className="font-normal text-muted-foreground text-sm">{token.label}</span>
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
            <span className="font-semibold text-lg">{token.value != null ? format(token.value) : '—'}</span>
            {token.yearlyYield != null ? <Badge variant="outline">{formatPercent(token.yearlyYield)}</Badge> : null}
            {token.volatility != null && risk ? (
              <Badge variant="outline">
                {t(($) => $.riskTitle)}: {t(($) => $[risk.label])}
              </Badge>
            ) : null}
          </div>
          <div className="grid grid-cols-2 gap-2 text-muted-foreground text-xs">
            {token.inceptionPrice != null ? (
              <div>
                {t(($) => $.tokenInfoInceptionPrice)}: {format(token.inceptionPrice)}
              </div>
            ) : null}
            {token.duration != null ? (
              <div>
                {t(($) => $.tokenInfoInception)}: {formatNumber(token.duration, { maximumFractionDigits: 0 })}{' '}
                {t(($) => $.tokenInfoDays)}
              </div>
            ) : null}
            {token.address ? (
              <div className="col-span-2 font-mono" title={token.address}>
                {ellipsify(token.address, 8)}
              </div>
            ) : null}
          </div>
          {token.description ? <p className="text-muted-foreground text-sm">{token.description}</p> : null}

          <div className="flex gap-1">
            {PERIODS.map((item) => (
              <Badge
                className="cursor-pointer"
                key={item.key}
                onClick={() => setPeriod(item.key)}
                variant={period === item.key ? 'default' : 'outline'}
              >
                {periodLabels[item.key]}
              </Badge>
            ))}
          </div>
          {prices.isLoading ? (
            <UiLoader />
          ) : (
            <div className="h-44 w-full">
              <ResponsiveContainer height="100%" width="100%">
                <LineChart data={points} margin={{ bottom: 0, left: 0, right: 8, top: 8 }}>
                  <CartesianGrid className="stroke-muted" strokeDasharray="3 3" vertical={false} />
                  <XAxis
                    className="text-xs"
                    dataKey="date"
                    minTickGap={40}
                    tickFormatter={(iso: string) => formatDate(iso)}
                    tickLine={false}
                  />
                  <YAxis
                    className="text-xs"
                    domain={['auto', 'auto']}
                    tickFormatter={(value: number) => format(value)}
                    tickLine={false}
                    width={70}
                  />
                  <Tooltip
                    formatter={(value) => [typeof value === 'number' ? format(value) : '—', token.symbol]}
                    labelFormatter={(iso) => formatDate(String(iso))}
                  />
                  <Line
                    dataKey="price"
                    dot={false}
                    stroke={rising ? '#22c55e' : '#ef4444'}
                    strokeWidth={2}
                    type="monotone"
                  />
                </LineChart>
              </ResponsiveContainer>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
