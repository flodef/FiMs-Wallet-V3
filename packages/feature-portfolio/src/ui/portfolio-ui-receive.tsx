import type { Address } from '@solana/kit'
import { useTranslation } from '@workspace/i18n'
import { UiQrCode } from '@workspace/ui/components/ui-qr-code'
import { UiTextCopyButton } from '@workspace/ui/components/ui-text-copy-button'

export function PortfolioUiReceive({ address }: { address: Address }) {
  const { t } = useTranslation('portfolio')

  return (
    <div className="space-y-6 p-2 text-center md:pb-10">
      <div className="flex flex-wrap justify-center gap-2">
        <UiTextCopyButton
          label={t(($) => $.actionCopyPublicKey)}
          text={address}
          toast={t(($) => $.actionCopyPublicKeySuccess)}
          toastFailed={t(($) => $.actionCopyPublicKeyError)}
        />
        <UiTextCopyButton
          label={t(($) => $.actionCopyPayLink)}
          text={`solana:${address}`}
          toast={t(($) => $.actionCopyPayLinkSuccess)}
          toastFailed={t(($) => $.actionCopyPayLinkError)}
        />
      </div>
      <div className="flex size-85 w-full justify-center">
        <div className="aspect-square">
          <UiQrCode content={address} />
        </div>
      </div>
    </div>
  )
}
