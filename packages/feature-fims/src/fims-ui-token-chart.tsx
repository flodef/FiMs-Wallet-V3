import { useTranslation } from '@workspace/i18n'
import { formatDateTime, formatNumber } from '@workspace/i18n/format'
import { Button } from '@workspace/ui/components/button'
import { UiCard } from '@workspace/ui/components/ui-card'
import { UiLoader } from '@workspace/ui/components/ui-loader'
import { cn } from '@workspace/ui/lib/utils'
import { useMemo, useState } from 'react'
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
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

const PERIOD_DAYS = { '1y': 365, '7d': 7, '30d': 30, all: Number.POSITIVE_INFINITY } as const
type Period = keyof typeof PERIOD_DAYS
type ScaleMode = 'linear' | 'log'

type Series = { points: Map<string, number>; symbol: string }

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
    .map(([symbol, map]) => ({ points: new Map([...map.entries()].sort(([a], [b]) => a.localeCompare(b))), symbol }))
    .filter((series) => series.points.size > 1)
    .sort((a, b) => a.symbol.localeCompare(b.symbol))
}

// Comparative token chart: the member picks the series (FiMs by default) and
// the window. A single series shows raw prices; several are rebased to 100 at
// the window start — plus a linear/log toggle like the big chart sites.
export function FimsUiTokenChart() {
  const { t } = useTranslation('fims')
  const prices = useFimsPrices()

  const series = useMemo(() => buildSeries(prices.data ?? []), [prices.data])
  const colorBySymbol = useMemo(
    () => new Map(series.map((s, i) => [s.symbol, PALETTE[i % PALETTE.length] ?? '#64748b'])),
    [series],
  )

  const [selected, setSelected] = useState<string[]>([])
  const [period, setPeriod] = useState<Period>('30d')
  const [scaleMode, setScaleMode] = useState<ScaleMode>('linear')

  const selectedSeries = useMemo(() => {
    const wanted = selected.length ? selected : series.some((s) => s.symbol === 'FiMs') ? ['FiMs'] : []
    return series.filter((s) => wanted.includes(s.symbol))
  }, [series, selected])

  // Rebased to 100 when several series are compared — raw price otherwise.
  const rebased = selectedSeries.length > 1

  const data = useMemo(() => {
    const lastDay = series
      .flatMap((s) => [...s.points.keys()])
      .sort()
      .at(-1)
    const days = PERIOD_DAYS[period]
    const cutoff =
      lastDay && Number.isFinite(days)
        ? new Date(Date.parse(lastDay) - days * 86_400_000).toISOString().slice(0, 10)
        : ''
    const windowed = selectedSeries.map((s) => {
      const entries = [...s.points.entries()].filter(([day]) => day >= cutoff)
      return { base: entries[0]?.[1] ?? 0, entries, symbol: s.symbol }
    })
    const allDays = [...new Set(windowed.flatMap((s) => s.entries.map(([day]) => day)))].sort()
    return allDays.map((day) => {
      const row: Record<string, number | string | undefined> = { date: day }
      for (const s of windowed) {
        const price = s.entries.find(([d]) => d === day)?.[1]
        if (price != null) {
          row[s.symbol] = rebased && s.base > 0 ? (price / s.base) * 100 : price
        }
      }
      return row
    })
  }, [period, rebased, selectedSeries, series])

  const variations = useMemo(
    () =>
      selectedSeries.map((s) => {
        const days = [...s.points.keys()].sort()
        const last = s.points.get(days.at(-1) ?? '') ?? 0
        const prevDay = days.at(-2)
        const prev = prevDay ? (s.points.get(prevDay) ?? last) : last
        return { day: prev > 0 ? last / prev - 1 : 0, symbol: s.symbol }
      }),
    [selectedSeries],
  )

  const toggle = (symbol: string) =>
    setSelected((current) => {
      const base = current.length ? current : ['FiMs']
      return base.includes(symbol) ? base.filter((s) => s !== symbol) : [...base, symbol]
    })

  const isSelected = (symbol: string) => (selected.length ? selected : ['FiMs']).includes(symbol)

  return (
    <UiCard title={t(($) => $.tokenChartTitle)}>
      {prices.isLoading ? (
        <UiLoader />
      ) : (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            {series.map((s) => (
              <button
                className={cn(
                  'flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition-colors',
                  isSelected(s.symbol)
                    ? 'border-primary bg-primary/10 font-medium'
                    : 'border-border text-muted-foreground hover:bg-muted/50',
                )}
                key={s.symbol}
                onClick={() => toggle(s.symbol)}
                type="button"
              >
                <span className="size-2.5 rounded-full" style={{ background: colorBySymbol.get(s.symbol) }} />
                {s.symbol}
              </button>
            ))}
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex gap-1">
              {(
                [
                  { key: '7d', label: t(($) => $.chartPeriod7d) },
                  { key: '30d', label: t(($) => $.chartPeriod30d) },
                  { key: '1y', label: t(($) => $.chartPeriod1y) },
                  { key: 'all', label: t(($) => $.chartPeriodAll) },
                ] as { key: Period; label: string }[]
              ).map((p) => (
                <Button
                  className="h-7 px-2.5 text-xs"
                  key={p.key}
                  onClick={() => setPeriod(p.key)}
                  variant={period === p.key ? 'default' : 'outline'}
                >
                  {p.label}
                </Button>
              ))}
            </div>
            <div className="flex gap-1">
              <Button
                className="h-7 px-2.5 text-xs"
                onClick={() => setScaleMode('linear')}
                variant={scaleMode === 'linear' ? 'default' : 'outline'}
              >
                {t(($) => $.chartScaleLinear)}
              </Button>
              <Button
                className="h-7 px-2.5 text-xs"
                onClick={() => setScaleMode('log')}
                variant={scaleMode === 'log' ? 'default' : 'outline'}
              >
                {t(($) => $.chartScaleLog)}
              </Button>
            </div>
          </div>
          <div className="h-64 w-full">
            <ResponsiveContainer height="100%" width="100%">
              <LineChart data={data} margin={{ bottom: 0, left: 0, right: 8, top: 8 }}>
                <CartesianGrid className="stroke-muted" strokeDasharray="3 3" vertical={false} />
                <XAxis
                  className="text-xs"
                  dataKey="date"
                  minTickGap={40}
                  tickFormatter={(iso: string) => formatDateTime(iso, { month: 'short', year: '2-digit' })}
                  tickLine={false}
                />
                <YAxis
                  className="text-xs"
                  domain={['auto', 'auto']}
                  scale={scaleMode}
                  tickFormatter={(v: number) => formatNumber(v, { maximumFractionDigits: 0 })}
                  tickLine={false}
                  width={44}
                />
                <Tooltip
                  formatter={(value, name) => [
                    typeof value === 'number'
                      ? rebased
                        ? formatNumber(value, { maximumFractionDigits: 1 })
                        : formatNumber(value, { maximumSignificantDigits: 6 })
                      : String(value ?? '—'),
                    String(name ?? ''),
                  ]}
                  labelFormatter={(label) =>
                    typeof label === 'string' ? formatDateTime(label, { dateStyle: 'medium' }) : String(label ?? '')
                  }
                />
                {selectedSeries.map((s) => (
                  <Line
                    connectNulls
                    dataKey={s.symbol}
                    dot={false}
                    isAnimationActive={false}
                    key={s.symbol}
                    stroke={colorBySymbol.get(s.symbol) ?? '#64748b'}
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
              </div>
            ))}
          </div>
          <p className="text-muted-foreground text-xs">
            {rebased ? t(($) => $.tokenChartHintRebased) : t(($) => $.tokenChartHint)}
          </p>
        </div>
      )}
    </UiCard>
  )
}
