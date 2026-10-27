import { useTranslation } from '@workspace/i18n'
import { useFimsCurrency } from './data-access/use-fims-currency.tsx'
import type { FimsMemberSummary } from './fims-api.ts'
import { formatPercent } from './fims-format.ts'
import { FimsUiRatioBadges } from './fims-ui-ratio-badges.tsx'

// Member summary tile: invested / current value / P&L plus the spreadsheet
// indicators (return ratio over gross deposits, real annualized rate on
// average deployed capital, total donated, membership duration). Values
// come from GET /fims/member-summary — the ledger recomputation, not the
// stale user_historic snapshot. Rendered inside the member card on the
// account page and standalone (in its own card) at the top of the
// portfolio for members.
export function FimsUiMemberSummary({ summary }: { summary: FimsMemberSummary | null | undefined }) {
  const { t } = useTranslation('fims')
  const { format } = useFimsCurrency()
  if (!summary) return null
  const months = summary.durationDays == null ? null : Math.ceil(summary.durationDays / (365.25 / 12))
  const years = summary.durationDays == null ? null : Math.ceil(summary.durationDays / 365.25)

  return (
    <div className="space-y-2">
      <div className="text-center text-muted-foreground text-xs">{t(($) => $.summaryPositionsFims)}</div>
      <div className="grid grid-cols-3 gap-4 text-center">
        <div>
          <div className="text-muted-foreground text-xs">{t(($) => $.labelInvested)}</div>
          <div className="font-semibold">{format(summary.invested)}</div>
        </div>
        <div>
          <div className="text-muted-foreground text-xs">{t(($) => $.labelCurrentValue)}</div>
          <div className="font-semibold">{format(summary.total)}</div>
        </div>
        <div>
          <div className="text-muted-foreground text-xs">{t(($) => $.labelPnl)}</div>
          <div className={summary.profit < 0 ? 'font-semibold text-red-500' : 'font-semibold text-green-500'}>
            {format(summary.profit)}
          </div>
          <FimsUiRatioBadges dayRatio={null} pnlRatio={summary.profitRatio} />
        </div>
      </div>
      <div className="flex flex-wrap justify-center gap-x-4 gap-y-1 text-muted-foreground text-xs">
        {summary.yearlyRate != null ? (
          <span>
            {t(($) => $.labelRealRate)}: {formatPercent(summary.yearlyRate)}
          </span>
        ) : null}
        {summary.donated > 0 ? (
          <span>
            {t(($) => $.summaryDonated)}: {format(summary.donated)}
          </span>
        ) : null}
        {months != null && years != null ? (
          <span>
            {t(($) => $.summaryMonths, { count: months })} ({t(($) => $.summaryYears, { count: years })})
          </span>
        ) : null}
      </div>
    </div>
  )
}
