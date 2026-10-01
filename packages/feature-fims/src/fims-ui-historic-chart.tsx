import { useTranslation } from '@workspace/i18n'
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { formatDate } from './fims-format.ts'

export type HistoricChartPoint = { date: string; invested: number; total: null | number }

const dateTickFormatter = new Intl.DateTimeFormat('fr-FR', { month: 'short', year: '2-digit' })

// Shared invested-vs-value area chart (member history, tontine, treasury).
export function FimsUiHistoricChart({
  format,
  points,
}: {
  format: (value: number) => string
  points: HistoricChartPoint[]
}) {
  const { t } = useTranslation('fims')
  const data = points.map((point) => ({ ...point, total: point.total ?? undefined }))

  return (
    <div className="h-64 w-full">
      <ResponsiveContainer height="100%" width="100%">
        <AreaChart data={data} margin={{ bottom: 0, left: 0, right: 8, top: 8 }}>
          <CartesianGrid className="stroke-muted" strokeDasharray="3 3" vertical={false} />
          <XAxis
            className="text-xs"
            dataKey="date"
            minTickGap={40}
            tickFormatter={(iso: string) => dateTickFormatter.format(new Date(iso))}
            tickLine={false}
          />
          <YAxis className="text-xs" tickFormatter={(value: number) => format(value)} tickLine={false} width={90} />
          <Tooltip
            formatter={(value, name) => [
              typeof value === 'number' ? format(value) : '—',
              name === 'invested' ? t(($) => $.chartInvested) : t(($) => $.chartTotal),
            ]}
            labelFormatter={(iso) => formatDate(String(iso))}
          />
          <Area
            dataKey="invested"
            fill="var(--muted)"
            fillOpacity={0.4}
            name={t(($) => $.chartInvested)}
            stroke="var(--muted-foreground)"
            type="monotone"
          />
          <Area
            dataKey="total"
            fill="var(--primary)"
            fillOpacity={0.2}
            name={t(($) => $.chartTotal)}
            stroke="var(--primary)"
            type="monotone"
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  )
}
