import { useTranslation } from '@workspace/i18n'
import { Button } from '@workspace/ui/components/button'
import { UiBottomSheet } from '@workspace/ui/components/ui-bottom-sheet'
import { UiIcon } from '@workspace/ui/components/ui-icon'
import { UiPrompt } from '@workspace/ui/components/ui-prompt'
import { UiQrRegionScan } from '@workspace/ui/components/ui-qr-region-scan'
import { UiQrScanner } from '@workspace/ui/components/ui-qr-scanner'
import { useEffect, useState } from 'react'
import { useSolanaPayRequest } from '../data-access/use-solana-pay-request.tsx'

// Solana Pay entry points: scan a QR with the camera (mobile), drag-select a
// QR shown anywhere on screen (desktop), or paste a solana: link. Each path
// decodes into the same send flow — token/amount/recipient prefilled.
export function PortfolioUiPayActions() {
  const { t } = useTranslation('portfolio')
  const request = useSolanaPayRequest()
  const [openCamera, setOpenCamera] = useState(false)
  const [openRegion, setOpenRegion] = useState(false)
  const canRegionScan =
    typeof navigator !== 'undefined' && typeof navigator.mediaDevices?.getDisplayMedia === 'function'

  // Lets solana: links anywhere on the device open this app's pay screen.
  // The browser asks for consent once; unsupported browsers silently skip.
  useEffect(() => {
    try {
      navigator.registerProtocolHandler('solana', `${window.location.origin}/modals/pay?uri=%s`)
    } catch {
      // Unsupported — the QR and paste paths still work.
    }
  }, [])

  function handleDecoded(value: string) {
    setOpenCamera(false)
    setOpenRegion(false)
    void request(value)
  }

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-2">
        <Button className="cursor-pointer" onClick={() => setOpenCamera(true)} type="button" variant="outline">
          <UiIcon className="size-4" icon="camera" />
          {t(($) => $.payActionScanQr)}
        </Button>
        <UiPrompt
          action={(value) => void request(value)}
          actionLabel={t(($) => $.payActionLinkSubmit)}
          description={t(($) => $.payActionLinkDescription)}
          label={t(($) => $.payActionLinkLabel)}
          placeholder="solana:…"
          title={t(($) => $.payActionLinkTitle)}
          value=""
        >
          <Button className="w-full cursor-pointer" type="button" variant="outline">
            <UiIcon className="size-4" icon="externalLink" />
            {t(($) => $.payActionPasteLink)}
          </Button>
        </UiPrompt>
      </div>
      {canRegionScan ? (
        <Button className="w-full cursor-pointer" onClick={() => setOpenRegion(true)} type="button" variant="outline">
          <UiIcon className="size-4" icon="image" />
          {t(($) => $.payActionRegionScan)}
        </Button>
      ) : null}

      <UiBottomSheet
        description={t(($) => $.payActionScanQrDescription)}
        onOpenChange={setOpenCamera}
        open={openCamera}
        title={t(($) => $.payActionScanQr)}
      >
        <div className="px-4 pb-4">{openCamera ? <UiQrScanner onScan={handleDecoded} /> : null}</div>
      </UiBottomSheet>

      <UiBottomSheet
        description={t(($) => $.payActionRegionScanDescription)}
        onOpenChange={setOpenRegion}
        open={openRegion}
        title={t(($) => $.payActionRegionScan)}
      >
        <div className="px-4 pb-4">
          {openRegion ? (
            <UiQrRegionScan
              noCodeMessage={t(($) => $.payActionRegionNoCode)}
              onScan={handleDecoded}
              reshareLabel={t(($) => $.payActionRegionReshare)}
            />
          ) : null}
        </div>
      </UiBottomSheet>
    </div>
  )
}
