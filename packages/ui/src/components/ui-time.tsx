import useRelativeTime from '@nkzw/use-relative-time'
import { formatDateTime } from '@workspace/i18n/format'
import type { ComponentProps } from 'react'
import { cn } from '../lib/utils.ts'

export function UiTime({ className, time, ...props }: { time: Date } & ComponentProps<'span'>) {
  const relative = useRelativeTime(time.getTime())
  return (
    <span
      className={cn('truncate whitespace-nowrap', className)}
      title={formatDateTime(time, { dateStyle: 'medium', timeStyle: 'short' })}
      {...props}
    >
      {relative}
    </span>
  )
}
