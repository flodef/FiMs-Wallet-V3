import { useQuery } from '@tanstack/react-query'
// cspell:ignore Nouveautés
import { useTranslation } from '@workspace/i18n'
import { Button } from '@workspace/ui/components/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@workspace/ui/components/dialog'
import { useState } from 'react'

const SEEN_KEY = 'fims-version-seen'
const LATEST_PREVIEW = 1

interface VersionEntry {
  bullets: string[]
  title: string
}

// Parses the public markdown into {title, bullets} — plain text only, no
// markup rendering (security: never dangerouslySetInnerHTML).
export function parseChangelog(markdown: string): VersionEntry[] {
  const entries: VersionEntry[] = []
  for (const line of markdown.split('\n')) {
    const heading = /^##\s+(.+)$/.exec(line.trim())
    if (heading?.[1]) {
      entries.push({ bullets: [], title: heading[1].trim() })
      continue
    }
    const bullet = /^-\s+(.+)$/.exec(line.trim())
    if (bullet?.[1] && entries.length) entries.at(-1)?.bullets.push(bullet[1].trim())
  }
  return entries
}

// v1 "Nouveautés" popup: shown once per changelog version — localStorage
// remembers the last version the user dismissed.
export function FimsUiVersionNotes() {
  const { t } = useTranslation('fims')
  const [showOlder, setShowOlder] = useState(false)
  const [dismissed, setDismissed] = useState(false)

  const notes = useQuery({
    queryFn: async () => {
      const res = await fetch('/CHANGELOG.md')
      if (!res.ok) return [] as VersionEntry[]
      return parseChangelog(await res.text())
    },
    queryKey: ['fims', 'changelog'],
    staleTime: 60 * 60 * 1000,
  })

  const entries = notes.data ?? []
  const latest = entries[0]?.title
  const seen = (() => {
    try {
      return localStorage.getItem(SEEN_KEY)
    } catch {
      return latest
    }
  })()
  const open = Boolean(latest && latest !== seen && !dismissed)

  const close = () => {
    try {
      if (latest) localStorage.setItem(SEEN_KEY, latest)
    } catch {
      // storage unavailable — the popup simply reappears next session
    }
    setDismissed(true)
  }

  const visible = showOlder ? entries : entries.slice(0, LATEST_PREVIEW)

  return (
    <Dialog onOpenChange={(next) => !next && close()} open={open}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t(($) => $.whatsNewTitle)}</DialogTitle>
        </DialogHeader>
        <div className="max-h-96 space-y-4 overflow-y-auto">
          {visible.map((entry) => (
            <div key={entry.title}>
              <div className="font-semibold">{entry.title}</div>
              <ul className="list-disc space-y-1 pl-5 text-muted-foreground text-sm">
                {entry.bullets.map((bullet) => (
                  <li key={bullet}>{bullet}</li>
                ))}
              </ul>
            </div>
          ))}
        </div>
        <div className="flex justify-between">
          {entries.length > LATEST_PREVIEW ? (
            <Button onClick={() => setShowOlder((value) => !value)} size="sm" variant="ghost">
              {showOlder ? t(($) => $.whatsNewLess) : t(($) => $.whatsNewOlder)}
            </Button>
          ) : (
            <span />
          )}
          <Button onClick={close} size="sm">
            {t(($) => $.whatsNewClose)}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
