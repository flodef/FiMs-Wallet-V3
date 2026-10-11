import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

import { cn } from '../lib/utils.ts'
import { UiIcon } from './ui-icon.tsx'
import type { UiIconName } from './ui-icon-map.tsx'

type UiTooltipSize = 'large' | 'medium' | 'small'

// Info tooltip: an icon button (or a custom trigger) that shows its content on
// hover/focus AND on click — the click path matters on touch devices where no
// hover exists. Rendered through a portal with viewport clamping so it works
// inside scrollable cards and modals.
export function UiTooltip({
  children,
  className,
  icon = 'help',
  orientation = 'vertical',
  size = 'medium',
  trigger,
}: {
  children: ReactNode
  className?: string
  icon?: UiIconName
  orientation?: 'horizontal' | 'vertical'
  size?: UiTooltipSize
  trigger?: ReactNode
}) {
  const [isVisible, setIsVisible] = useState(false)
  const tooltipRef = useRef<HTMLDivElement>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const [position, setPosition] = useState({ left: 0, top: 0 })

  const widthClasses = {
    large: 'w-[400px] max-w-[calc(100vw-20px)]',
    medium: 'w-[300px] max-w-[calc(100vw-20px)]',
    small: 'w-[200px] max-w-[calc(100vw-20px)]',
  }

  const calculatePosition = useCallback(() => {
    const ref = trigger ? triggerRef : buttonRef
    if (!ref?.current) {
      return { left: 0, top: 0 }
    }

    const rect = ref.current.getBoundingClientRect()
    const padding = 10
    const tooltipWidth = Math.min({ large: 400, medium: 300, small: 200 }[size], window.innerWidth - padding * 2)
    const tooltipHeight = tooltipRef.current?.offsetHeight || 100

    let top: number
    let left: number

    if (orientation === 'vertical') {
      // Prefer above when there is room, otherwise below.
      top = rect.top >= tooltipHeight + padding ? rect.top - tooltipHeight - padding : rect.bottom + padding
      top = Math.max(padding, Math.min(top, window.innerHeight - tooltipHeight - padding))

      left = rect.left + (rect.width - tooltipWidth) / 2
      if (left + tooltipWidth > window.innerWidth - padding) {
        left = window.innerWidth - tooltipWidth - padding
      }
      if (left < padding) {
        left = padding
      }
    } else {
      // Prefer left when there is room, otherwise right.
      left = rect.left >= tooltipWidth + padding ? rect.left - tooltipWidth - padding : rect.right + padding
      left = Math.max(padding, Math.min(left, window.innerWidth - tooltipWidth - padding))

      top = rect.top + (rect.height - tooltipHeight) / 2
      top = Math.max(padding, Math.min(top, window.innerHeight - tooltipHeight - padding))
    }

    return { left, top }
  }, [orientation, trigger, size])

  useEffect(() => {
    if (isVisible) {
      setPosition(calculatePosition())
    }
  }, [isVisible, calculatePosition])

  return (
    <span className="inline-flex items-center">
      {trigger ? (
        <button
          className={cn('inline-flex cursor-help items-center', className)}
          onClick={(event) => {
            event.stopPropagation()
            setIsVisible((visible) => !visible)
          }}
          onMouseEnter={() => setIsVisible(true)}
          onMouseLeave={() => setIsVisible(false)}
          ref={triggerRef}
          type="button"
        >
          {trigger}
        </button>
      ) : (
        <button
          aria-label="Information"
          className={cn('mx-1 cursor-help hover:text-foreground focus:outline-none', className)}
          onClick={(event) => {
            event.stopPropagation()
            setIsVisible((visible) => !visible)
          }}
          onMouseEnter={() => setIsVisible(true)}
          onMouseLeave={() => setIsVisible(false)}
          ref={buttonRef}
          type="button"
        >
          <UiIcon className="size-4 text-muted-foreground" icon={icon} />
        </button>
      )}

      {isVisible
        ? createPortal(
            <div
              className={cn(
                'fixed z-[100] rounded-md border bg-popover p-2 text-popover-foreground text-sm shadow-lg',
                widthClasses[size],
              )}
              ref={tooltipRef}
              style={{ left: `${position.left}px`, top: `${position.top}px` }}
            >
              {children}
            </div>,
            document.body,
          )
        : null}
    </span>
  )
}
