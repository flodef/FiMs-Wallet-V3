import { useTranslation } from '@workspace/i18n'
import { UiQrScanner } from '@workspace/ui/components/ui-qr-scanner'

// Camera picker for the device-to-device transfer: scans the QR shown by the
// source wallet and hands the decoded payload back.
export function OnboardingUiQrScanner({ onScan }: { onScan: (value: string) => void }) {
  const { t } = useTranslation('onboarding')
  return <UiQrScanner errorMessage={t(($) => $.importTransferScanError)} onScan={onScan} />
}
