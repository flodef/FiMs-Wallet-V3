import { resolveLanguage, useTranslation } from '@workspace/i18n'
import { formatDateTime } from '@workspace/i18n/format'
import { format, isThisWeek, isToday, isYesterday, type Locale } from 'date-fns'
import { enUS, es, fr } from 'date-fns/locale'

const DATE_FNS_LOCALES: Record<ReturnType<typeof resolveLanguage>, Locale> = { en: enUS, es, fr }

import type { ComponentProps } from 'react'
import { cn } from '../lib/utils.ts'

function useRelativeDate({ date }: { date: Date }) {
  const { i18n, t } = useTranslation('ui')
  const locale = DATE_FNS_LOCALES[resolveLanguage(i18n.resolvedLanguage)]
  if (isToday(date)) {
    return t(($) => $.relativeDateToday)
  }
  if (isYesterday(date)) {
    return t(($) => $.relativeDateYesterday)
  }
  if (isThisWeek(date)) {
    return format(date, 'EEEE', { locale })
  }
  return format(date, 'MMM d', { locale })
}

export function UiRelativeDate({ className, date, ...props }: { date: Date } & ComponentProps<'span'>) {
  const relative = useRelativeDate({ date })

  return (
    <span
      className={cn('truncate whitespace-nowrap', className)}
      title={formatDateTime(date, { dateStyle: 'medium' })}
      {...props}
    >
      {relative}
    </span>
  )
}
