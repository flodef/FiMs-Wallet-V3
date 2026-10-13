import type { Network } from '@workspace/db/network/network'
import { useTranslation } from '@workspace/i18n'
import { Alert, AlertDescription, AlertTitle } from '@workspace/ui/components/alert'
import { UiIcon } from '@workspace/ui/components/ui-icon'

// Persistent banner while the active network is not mainnet: test networks
// hold no real value and everything displayed there is a simulation. It is
// not dismissible — it stays up for the whole devnet/testnet session.
export function ShellUiNetworkBanner({ network }: { network: Network }) {
  const { t } = useTranslation('shell')
  if (network.type === 'solana:mainnet') {
    return null
  }

  return (
    <Alert className="rounded-none border-x-0 border-t-0" variant="warning">
      <UiIcon icon="alert" />
      <AlertTitle>{t(($) => $.networkWarningTitle)}</AlertTitle>
      <AlertDescription>{t(($) => $.networkWarningBody, { network: network.name })}</AlertDescription>
    </Alert>
  )
}
