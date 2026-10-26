import { useTranslation } from '@workspace/i18n'
import { Select, SelectContent, SelectItem, SelectTrigger } from '@workspace/ui/components/select'
import { cn } from '@workspace/ui/lib/utils'

export interface FimsTokenOption {
  balance?: null | string
  icon?: null | string
  label?: null | string
  symbol: string
  value: string
}

// Swap-style amount panel (jup.ag look): a rounded card holding the label and
// balance on top, the big amount input next to a token chip selector, and the
// fiat estimate plus quick-fill chips underneath.
export function FimsUiTokenAmountInput({
  amount,
  balance,
  label,
  onAmountChange,
  onHalf,
  onMax,
  onTokenChange,
  options,
  readOnly = false,
  tokenPlaceholder,
  tokenValue,
  valueText,
}: {
  amount: string
  balance?: null | string
  label: string
  onAmountChange?: ((value: string) => void) | undefined
  onHalf?: (() => void) | undefined
  onMax?: (() => void) | undefined
  onTokenChange: (value: string) => void
  options: FimsTokenOption[]
  readOnly?: boolean
  tokenPlaceholder?: string | undefined
  tokenValue: string
  valueText?: null | string
}) {
  const { t } = useTranslation('fims')
  const selected = options.find((option) => option.value === tokenValue)

  return (
    <div className="space-y-1 rounded-xl border bg-muted/40 p-3">
      <div className="flex items-center justify-between text-muted-foreground text-xs">
        <span>{label}</span>
        {balance != null ? (
          <span>
            {t(($) => $.tokenBalance)}: {balance}
          </span>
        ) : null}
      </div>
      <div className="flex items-center gap-2">
        <input
          aria-label={label}
          className={cn(
            'min-w-0 flex-1 bg-transparent font-semibold text-2xl outline-none placeholder:text-muted-foreground/50',
            readOnly && 'text-muted-foreground',
          )}
          inputMode="decimal"
          onChange={(e) => onAmountChange?.(e.target.value)}
          placeholder="0.0"
          readOnly={readOnly}
          value={amount}
        />
        <Select onValueChange={onTokenChange} value={tokenValue}>
          <SelectTrigger className="h-9 w-auto shrink-0 gap-1.5 rounded-full bg-background px-3">
            {selected ? (
              <>
                {selected.icon ? <img alt="" className="size-5 rounded-full" src={selected.icon} /> : null}
                <span className="font-semibold">{selected.symbol}</span>
              </>
            ) : (
              <span className="text-muted-foreground text-sm">{tokenPlaceholder}</span>
            )}
          </SelectTrigger>
          <SelectContent>
            {options.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                <span className="flex items-center gap-2">
                  {option.icon ? <img alt="" className="size-4 rounded-full" src={option.icon} /> : null}
                  <span>
                    {option.symbol}
                    {option.label ? <span className="text-muted-foreground"> — {option.label}</span> : null}
                    {option.balance != null ? <span className="text-muted-foreground"> · {option.balance}</span> : null}
                  </span>
                </span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="flex min-h-6 items-center justify-between text-muted-foreground text-xs">
        <span>{valueText ?? ''}</span>
        <span className="flex gap-1">
          {onHalf ? (
            <button
              className="rounded-full bg-background px-2 py-0.5 font-semibold text-[10px] uppercase hover:bg-muted"
              onClick={onHalf}
              type="button"
            >
              50%
            </button>
          ) : null}
          {onMax ? (
            <button
              className="rounded-full bg-background px-2 py-0.5 font-semibold text-[10px] uppercase hover:bg-muted"
              onClick={onMax}
              type="button"
            >
              {t(($) => $.swapMax)}
            </button>
          ) : null}
        </span>
      </div>
    </div>
  )
}
