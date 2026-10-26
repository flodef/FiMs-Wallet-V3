import { useTranslation } from '@workspace/i18n'
import { useFimsCurrency } from './data-access/use-fims-currency.tsx'
import type { FimsUserHistoricPoint } from './fims-api.ts'
import { formatPercent } from './fims-format.ts'
import { annualizedRate } from './fims-performance.ts'
import { FimsUiRatioBadges } from './fims-ui-ratio-badges.tsx'

// Member summary tile: invested / current value / P&L with day and total
// ratios plus the realized annual rate. Rendered inside the member card on
// the account page and standalone (in its own card) at the top of the
// portfolio for members.
export function FimsUiMemberSummary({ historic }: { historic: FimsUserHistoricPoint[] }) {
  const { t } = useTranslation('fims')
  const { format } = useFimsCurrency()
  const latest = historic.at(-1)
  const previous = historic.at(-2)
  const first = historic.at(0)
  const pnl = latest?.total != null ? latest.total - latest.invested : null
  const pnlRatio = latest && latest.invested > 0 && pnl != null ? pnl / latest.invested : null
  const dayRatio =
    latest?.total != null && previous?.total != null && previous.total > 0
      ? (latest.total - previous.total) / previous.total
      : null
  // Realized rate: what the position actually earned, annualized over the
  // real holding period — unlike a projected current rate. The whole
  // invested amount is treated as held since the first historic entry.
  const realRate =
    first && latest
      ? annualizedRate({ date: first.date, value: latest.invested }, { date: latest.date, value: latest.total ?? 0 })
      : undefined

  return (
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
  )
}
