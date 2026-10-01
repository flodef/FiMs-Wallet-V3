import { useTranslation } from '@workspace/i18n'
import { formatPercent } from './fims-format.ts'

// Two small badges under the P&L: the day-over-day change (last two history
// points) and the total return since first investment. The title attribute
// acts as the tooltip.
export function FimsUiRatioBadges({ dayRatio, pnlRatio }: { dayRatio: null | number; pnlRatio: null | number }) {
  const { t } = useTranslation('fims')
  if (pnlRatio == null && dayRatio == null) return null
  return (
    <div className="mt-1 flex flex-wrap justify-center gap-1">
      {dayRatio != null ? (
        <span
          className={`rounded px-1.5 py-0.5 font-medium text-xs ${
            dayRatio < 0 ? 'bg-red-500/10 text-red-500' : 'bg-green-500/10 text-green-500'
          }`}
          title={t(($) => $.ratioDayTooltip)}
        >
          {t(($) => $.ratioDay)} {formatPercent(dayRatio)}
        </span>
      ) : null}
      {pnlRatio != null ? (
        <span
          className={`rounded px-1.5 py-0.5 font-medium text-xs ${
            pnlRatio < 0 ? 'bg-red-500/10 text-red-500' : 'bg-green-500/10 text-green-500'
          }`}
          title={t(($) => $.ratioTotalTooltip)}
        >
          {t(($) => $.ratioTotal)} {formatPercent(pnlRatio)}
        </span>
      ) : null}
    </div>
  )
}
