import { cn } from '../lib/utils.ts'

// FiMs loading dots (ported from the v1 wallet): three brand dots where the
// middle ones slide right while the ends grow/shrink back — always centered
// in its container. Size classes scale the track down for inline use
// (buttons, badges).
export function UiLoader({ className }: { className?: string | undefined }) {
  const inline = className != null && /(^|\s)size-\d/.test(className)
  return (
    <span className={cn('flex items-center justify-center', !inline && 'w-full', className)}>
      <span className={cn('ui-loader-track', inline && 'ui-loader-track-inline')}>
        <span className="ui-loader-dot ui-loader-grow" />
        <span className="ui-loader-dot ui-loader-move" />
        <span className="ui-loader-dot ui-loader-move" />
        <span className="ui-loader-dot ui-loader-grow-reverse" />
      </span>
    </span>
  )
}
