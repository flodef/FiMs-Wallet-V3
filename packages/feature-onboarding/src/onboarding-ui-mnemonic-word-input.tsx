import { getMnemonicWordStatus } from '@workspace/keypair/get-mnemonic-word-status'
import { Input } from '@workspace/ui/components/input'
import { Label } from '@workspace/ui/components/label'
import { cn } from '@workspace/ui/lib/utils'

export function OnboardingUiMnemonicWordInput({
  index,
  onChange,
  onPaste,
  value,
}: {
  index: number
  onChange: (index: number, word: string) => void
  onPaste: (e: DataTransfer, index: number) => void
  value: string
}) {
  const invalid = getMnemonicWordStatus(value) === 'invalid'
  return (
    <div className="relative">
      <Label
        className="absolute -top-2 left-2 inline-block bg-white px-1 font-medium text-xs text-zinc-500 dark:bg-zinc-900 dark:text-zinc-400"
        htmlFor={`word-${index}`}
      >
        {index}
      </Label>
      <Input
        aria-invalid={invalid}
        autoComplete="off"
        autoCorrect="off"
        className={cn(
          'block w-full rounded-md border-0 bg-transparent px-3 py-2.5 text-zinc-900 shadow-sm ring-1 ring-zinc-300 ring-inset transition-all duration-150 placeholder:text-zinc-400 focus:ring-2 focus:ring-blue-600 focus:ring-inset sm:text-sm sm:leading-6 dark:text-zinc-50 dark:ring-zinc-700 dark:focus:ring-blue-500 dark:placeholder:text-zinc-500',
          invalid && 'ring-2 ring-red-500 focus:ring-red-500 dark:ring-red-500 dark:focus:ring-red-500',
        )}
        id={`word-${index}`}
        onChange={(event) => onChange(index - 1, event.target.value)}
        onKeyDown={(event) => {
          if (event.key === ' ') {
            event.preventDefault()
            document.getElementById(`word-${index + 1}`)?.focus()
          }
        }}
        onPaste={(event) => {
          event.preventDefault()
          onPaste(event.clipboardData, index - 1)
        }}
        spellCheck="false"
        type="text"
        value={value}
      />
    </div>
  )
}
