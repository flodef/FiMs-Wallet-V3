import { useTranslation } from '@workspace/i18n'
import { Spinner } from '@workspace/ui/components/spinner'
import QrScanner from 'qr-scanner'
import { useEffect, useRef, useState } from 'react'

// Camera picker for the device-to-device transfer: scans the QR shown by the
// source wallet and hands the decoded payload back. The library decodes in a
// worker — nothing leaves the device.
export function OnboardingUiQrScanner({ onScan }: { onScan: (value: string) => void }) {
  const { t } = useTranslation('onboarding')
  const videoRef = useRef<HTMLVideoElement>(null)
  const onScanRef = useRef(onScan)
  onScanRef.current = onScan
  const [error, setError] = useState<string>()
  const [ready, setReady] = useState(false)

  useEffect(() => {
    const video = videoRef.current
    if (!video) {
      return
    }
    const scanner = new QrScanner(video, (result) => onScanRef.current(result.data), {
      highlightScanRegion: true,
      returnDetailedScanResult: true,
    })
    scanner
      .start()
      .then(() => setReady(true))
      .catch((caught: unknown) => setError(caught instanceof Error ? caught.message : String(caught)))
    return () => {
      scanner.destroy()
    }
  }, [])

  if (error) {
    return <p className="text-center text-muted-foreground text-sm">{t(($) => $.importTransferScanError)}</p>
  }

  return (
    <div className="relative aspect-square w-full overflow-hidden rounded-lg">
      {!ready ? (
        <div className="absolute inset-0 flex items-center justify-center">
          <Spinner />
        </div>
      ) : null}
      <video className="size-full object-cover" muted playsInline ref={videoRef} />
    </div>
  )
}
