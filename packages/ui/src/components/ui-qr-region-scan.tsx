import { useTranslation } from '@workspace/i18n'
import { Button } from '@workspace/ui/components/button'
import { Spinner } from '@workspace/ui/components/spinner'
import { UiIcon } from '@workspace/ui/components/ui-icon'
import QrScanner from 'qr-scanner'
import { type PointerEvent as ReactPointerEvent, useCallback, useEffect, useRef, useState } from 'react'

// Screen-region QR scan (desktop): captures the display through
// getDisplayMedia, then the user drags a rectangle around a QR code shown
// anywhere on screen. The crop is decoded locally — nothing is uploaded.
export function UiQrRegionScan({
  errorMessage,
  noCodeMessage,
  onScan,
  reshareLabel,
}: {
  errorMessage?: string
  noCodeMessage?: string
  onScan: (value: string) => void
  reshareLabel?: string
}) {
  const { t } = useTranslation('ui')
  const videoRef = useRef<HTMLVideoElement>(null)
  const streamRef = useRef<MediaStream | undefined>(undefined)
  const onScanRef = useRef(onScan)
  onScanRef.current = onScan
  const [error, setError] = useState<string>()
  const [noCode, setNoCode] = useState(false)
  const [ready, setReady] = useState(false)
  const [decoding, setDecoding] = useState(false)
  const startRef = useRef<{ x: number; y: number } | undefined>(undefined)
  const [rect, setRect] = useState<{ height: number; width: number; x: number; y: number }>()

  const startCapture = useCallback(() => {
    setError(undefined)
    setReady(false)
    setRect(undefined)
    setNoCode(false)
    navigator.mediaDevices
      .getDisplayMedia({ video: true })
      .then((media) => {
        streamRef.current = media
        // The user stopped sharing from the browser UI — offer to re-share.
        media.getVideoTracks()[0]?.addEventListener('ended', () => setReady(false))
        const video = videoRef.current
        if (video) {
          video.srcObject = media
          video.onloadedmetadata = () => {
            void video.play().then(() => setReady(true))
          }
        }
      })
      .catch((caught: unknown) => setError(caught instanceof Error ? caught.message : String(caught)))
  }, [])

  useEffect(() => {
    startCapture()
    return () => {
      for (const track of streamRef.current?.getTracks() ?? []) {
        track.stop()
      }
    }
  }, [startCapture])

  function handlePointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (decoding) {
      return
    }
    event.currentTarget.setPointerCapture(event.pointerId)
    const bounds = event.currentTarget.getBoundingClientRect()
    startRef.current = { x: event.clientX - bounds.left, y: event.clientY - bounds.top }
    setRect({ height: 0, width: 0, x: startRef.current.x, y: startRef.current.y })
    setNoCode(false)
  }

  function handlePointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    const start = startRef.current
    if (!start) {
      return
    }
    const bounds = event.currentTarget.getBoundingClientRect()
    const current = { x: event.clientX - bounds.left, y: event.clientY - bounds.top }
    setRect({
      height: Math.abs(current.y - start.y),
      width: Math.abs(current.x - start.x),
      x: Math.min(start.x, current.x),
      y: Math.min(start.y, current.y),
    })
  }

  async function handlePointerUp() {
    const selection = rect
    const video = videoRef.current
    startRef.current = undefined
    if (!selection || !video || selection.width < 24 || selection.height < 24) {
      setRect(undefined)
      return
    }
    setDecoding(true)
    try {
      const scale = video.videoWidth / video.clientWidth
      const canvas = document.createElement('canvas')
      canvas.width = Math.round(selection.width * scale)
      canvas.height = Math.round(selection.height * scale)
      const context = canvas.getContext('2d')
      if (!context) {
        throw new Error('Canvas unavailable')
      }
      context.drawImage(
        video,
        selection.x * scale,
        selection.y * scale,
        selection.width * scale,
        selection.height * scale,
        0,
        0,
        canvas.width,
        canvas.height,
      )
      const result = await QrScanner.scanImage(canvas, { returnDetailedScanResult: true })
      onScanRef.current(result.data)
    } catch {
      setNoCode(true)
      setRect(undefined)
    } finally {
      setDecoding(false)
    }
  }

  if (error) {
    return <p className="text-center text-muted-foreground text-sm">{errorMessage ?? t(($) => $.errorTitle)}</p>
  }

  return (
    <div className="space-y-2">
      <div className="relative w-full cursor-crosshair touch-none overflow-hidden rounded-lg">
        <video className="h-auto w-full" muted playsInline ref={videoRef} />
        {!ready ? (
          <div className="absolute inset-0 flex aspect-video items-center justify-center">
            <Spinner />
          </div>
        ) : null}
        {ready ? (
          <div
            className="absolute inset-0"
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={() => void handlePointerUp()}
          >
            {rect ? (
              <div
                className="absolute border-2 border-primary bg-primary/10"
                style={{ height: rect.height, left: rect.x, top: rect.y, width: rect.width }}
              />
            ) : null}
            {decoding ? (
              <div className="absolute inset-0 flex items-center justify-center bg-background/60">
                <Spinner />
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
      {noCode ? (
        <p className="flex items-center gap-1 text-destructive text-sm">
          <UiIcon className="size-4" icon="alert" />
          {noCodeMessage ?? t(($) => $.errorTitle)}
        </p>
      ) : null}
      <div className="flex justify-center">
        <Button className="cursor-pointer" onClick={startCapture} size="sm" type="button" variant="ghost">
          {reshareLabel ?? t(($) => $.qrScanReshare)}
        </Button>
      </div>
    </div>
  )
}
