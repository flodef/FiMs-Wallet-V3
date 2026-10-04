import { useTranslation } from '@workspace/i18n'
import { UiError } from '@workspace/ui/components/ui-error'
import { UiLoader } from '@workspace/ui/components/ui-loader'
import { useEffect } from 'react'
import { useSearchParams } from 'react-router'
import { useSolanaPayRequest } from './data-access/use-solana-pay-request.tsx'
import { PortfolioUiModal } from './ui/portfolio-ui-modal.tsx'

// Deep-link entry for solana: payment URIs (registered via
// registerProtocolHandler): /modals/pay?uri=<url-encoded solana: link>.
// Resolves the request and forwards into the regular send flow.
export function PortfolioFeatureModalPay() {
  const { t } = useTranslation('portfolio')
  const [searchParams] = useSearchParams()
  const request = useSolanaPayRequest()
  const uri = searchParams.get('uri')

  // biome-ignore lint/correctness/useExhaustiveDependencies: only re-run when the uri changes
  useEffect(() => {
    if (uri) {
      void request(uri, { from: '/portfolio' })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uri])

  return (
    <PortfolioUiModal title={t(($) => $.payTitle)}>
      {uri ? (
        <div className="flex items-center gap-2 rounded-md border p-3 text-muted-foreground text-sm">
          <UiLoader className="size-4" />
          {t(($) => $.payResolving)}
        </div>
      ) : (
        <UiError message={new Error('Missing payment link')} title={t(($) => $.payTitle)} />
      )}
    </PortfolioUiModal>
  )
}
