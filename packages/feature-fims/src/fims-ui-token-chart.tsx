import { useTranslation } from '@workspace/i18n'
import { UiCard } from '@workspace/ui/components/ui-card'
import { UiLoader } from '@workspace/ui/components/ui-loader'
import { useMemo } from 'react'
import { CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { useFimsPrices } from './data-access/use-fims.tsx'
import { formatPercent } from './fims-format.ts'
import { isSafeSymbol } from './fims-risk.ts'

const PALETTE = [
  '#0ea5e9',
  '#f59e0b',
  '#10b981',
  '#8b5cf6',
  '#ef4444',
  '#ec4899',
  '#14b8a6',
  '#f97316',
  '#6366f1',
  '#84cc16',
]

const dateTickFormatter = new Intl.DateTimeFormat('fr-FR', { month: 'short', year: '2-digit' })
const percentTickFormatter = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 0 })

type Series = { base: number; points: Map<string, number>; symbol: string }

function buildSeries(points: { date: string; price: number; token: string }[]): Series[] {
  const byToken = new Map<string, Map<string, number>>()
  for (const point of points) {
    const day = point.date.slice(0, 10)
    const map = byToken.get(point.token) ?? new Map<string, number>()
    map.set(day, point.price)
    byToken.set(point.token, map)
  }
  return [...byToken.entries()]
    .filter(([symbol]) => !isSafeSymbol(symbol))
    .map(([symbol, map]) => {
      const sorted = [...map.entries()].sort(([a], [b]) => a.localeCompare(b))
      return { base: sorted[0]?.[1] ?? 0, points: new Map(sorted), symbol }
    })
    .filter((series) => series.base > 0 && series.points.size > 1)
    .sort((a, b) => a.symbol.localeCompare(b.symbol))
}

// Comparative token chart: every non-stable token rebased to 100 at its first
// price point so relative performance is comparable across volatile scales.
export function FimsUiTokenChart() {
  const { t } = useTranslation('fims')
  const prices = useFimsPrices()

  const series = useMemo(() => buildSeries(prices.data ?? []), [prices.data])

  const data = useMemo(() => {
    const days = [...new Set(series.flatMap((s) => [...s.points.keys()]))].sort()
    return days.map((day) => {
      const row: Record<string, number | string | undefined> = { date: day }
      for (const s of series) {
        const price = s.points.get(day)
        if (price != null) {
          row[s.symbol] = (price / s.base) * 100
        }
      }
      return row
    })
  }, [series])

  const variations = useMemo(
    () =>
      series.map((s) => {
        const days = [...s.points.keys()].sort()
        const last = s.points.get(days.at(-1) ?? '') ?? s.base
        const prevDay = days.at(-2)
        const prev = prevDay ? (s.points.get(prevDay) ?? last) : last
        return { day: prev > 0 ? last / prev - 1 : 0, symbol: s.symbol, total: last / s.base - 1 }
      }),
    [series],
  )

  return (
    <UiCard title={t(($) => $.tokenChartTitle)}>
      {prices.isLoading ? (
        <UiLoader />
      ) : (
        <div className="space-y-4">
          <div className="h-64 w-full">
            <ResponsiveContainer height="100%" width="100%">
              <LineChart data={data} margin={{ bottom: 0, left: 0, right: 8, top: 8 }}>
                <CartesianGrid className="stroke-muted" strokeDasharray="3 3" vertical={false} />
                <XAxis
                  className="text-xs"
                  dataKey="date"
                  minTickGap={40}
                  tickFormatter={(iso: string) => dateTickFormatter.format(new Date(iso))}
                  tickLine={false}
                />
                <YAxis
                  className="text-xs"
                  tickFormatter={(v: number) => percentTickFormatter.format(v)}
                  tickLine={false}
                  width={44}
                />
                <Tooltip
                  formatter={(value, name) => [
                    typeof value === 'number' ? percentTickFormatter.format(value) : String(value ?? '—'),
                    String(name ?? ''),
                  ]}
                  labelFormatter={(label) =>
                    typeof label === 'string' ? new Date(label).toLocaleDateString() : String(label ?? '')
                  }
                />
                <Legend />
                {series.map((s, i) => (
                  <Line
                    connectNulls
                    dataKey={s.symbol}
                    dot={false}
                    isAnimationActive={false}
                    key={s.symbol}
                    stroke={PALETTE[i % PALETTE.length] ?? '#64748b'}
                    strokeWidth={2}
                    type="monotone"
                  />
                ))}
              </LineChart>
            </ResponsiveContainer>
          </div>
          <div className="flex flex-wrap gap-2">
            {variations.map((v) => (
              <div className="rounded-md border px-2 py-1 text-xs" key={v.symbol}>
                <span className="font-medium">{v.symbol}</span>{' '}
                <span className={v.day >= 0 ? 'text-green-600' : 'text-red-500'}>
                  {v.day >= 0 ? '+' : ''}
                  {formatPercent(v.day)}
                </span>
                <span className="text-muted-foreground"> / </span>
                <span className={v.total >= 0 ? 'text-green-600' : 'text-red-500'}>
                  {v.total >= 0 ? '+' : ''}
                  {formatPercent(v.total)}
                </span>
              </div>
            ))}
          </div>
          <p className="text-muted-foreground text-xs">{t(($) => $.tokenChartHint)}</p>
        </div>
      )}
    </UiCard>
  )
}
