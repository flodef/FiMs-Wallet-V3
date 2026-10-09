import { useTranslation } from '@workspace/i18n'

// Which site is asking — always shown on top of every approval screen so the
// user can spot a phishing origin before approving.
export function RequestUiOrigin({ origin }: { origin: string }) {
  const { t } = useTranslation('request')
  let host = origin
  try {
    host = new URL(origin).host
  } catch {
    // keep the raw string when the origin is not a URL
  }
  return (
    <div className="rounded-md border p-3 text-center">
      <div className="text-muted-foreground text-xs">{t(($) => $.requestOrigin)}</div>
      <div className="font-mono text-sm">{host}</div>
    </div>
  )
}
