import { useAppContext } from '@workspace/context-react/use-app-context'
import { useSetting } from '@workspace/db-react/use-setting'
import { useTranslation } from '@workspace/i18n'
import { Button } from '@workspace/ui/components/button'
import { Input } from '@workspace/ui/components/input'
import { Label } from '@workspace/ui/components/label'
import { UiLoader } from '@workspace/ui/components/ui-loader'
import { toastError } from '@workspace/ui/lib/toast-error'
import { useId, useRef, useState } from 'react'

// Downscale to a sane wallpaper size before storing the data URL in the local
// settings DB — a raw phone photo would blow up to several MB.
const MAX_DIMENSION = 1600
const JPEG_QUALITY = 0.82
const MAX_DATA_URL_LENGTH = 1_500_000

async function fileToWallpaperDataUrl(file: File): Promise<string> {
  const bitmap = await createImageBitmap(file)
  const scale = Math.min(1, MAX_DIMENSION / Math.max(bitmap.width, bitmap.height))
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(bitmap.width * scale))
  canvas.height = Math.max(1, Math.round(bitmap.height * scale))
  const context = canvas.getContext('2d')
  if (!context) {
    throw new Error('Canvas is unavailable')
  }
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
  bitmap.close()
  const dataUrl = canvas.toDataURL('image/jpeg', JPEG_QUALITY)
  if (dataUrl.length > MAX_DATA_URL_LENGTH) {
    throw new Error('Image is too large even after compression')
  }
  return dataUrl
}

export function SettingsFeatureGeneralWallpaper() {
  const { t } = useTranslation('settings')
  const fileId = useId()
  const inputRef = useRef<HTMLInputElement | null>(null)
  const ctx = useAppContext()
  const [wallpaper, setWallpaper] = useSetting('themeWallpaper')
  const [busy, setBusy] = useState(false)

  async function removeWallpaper() {
    const row = await ctx.db.settings.get({ key: 'themeWallpaper' })
    if (row) {
      await ctx.db.settings.delete(row.id)
    }
  }

  async function handleFile(file: File | undefined) {
    if (!file) {
      return
    }
    setBusy(true)
    try {
      await setWallpaper(await fileToWallpaperDataUrl(file))
    } catch (error) {
      toastError(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
      if (inputRef.current) {
        inputRef.current.value = ''
      }
    }
  }

  return (
    <div className="space-y-2">
      <Label htmlFor={fileId}>{t(($) => $.pageGeneralWallpaper)}</Label>
      <p className="text-muted-foreground text-sm">{t(($) => $.pageGeneralWallpaperHint)}</p>
      {wallpaper ? (
        <div className="space-y-2">
          <img
            alt={t(($) => $.pageGeneralWallpaper)}
            className="h-24 w-full rounded-md border object-cover"
            src={wallpaper}
          />
          <Button onClick={() => void removeWallpaper()} variant="outline">
            {t(($) => $.pageGeneralWallpaperRemove)}
          </Button>
        </div>
      ) : (
        <div className="flex items-center gap-2">
          <Input
            accept="image/*"
            disabled={busy}
            id={fileId}
            onChange={(event) => void handleFile(event.target.files?.[0])}
            ref={inputRef}
            type="file"
          />
          {busy ? <UiLoader className="size-4" /> : null}
        </div>
      )}
    </div>
  )
}
