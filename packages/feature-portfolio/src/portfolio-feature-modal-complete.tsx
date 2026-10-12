import { assertIsSignature } from '@solana/kit'

import { ExplorerUiTxExternalLink } from '@workspace/feature-explorer/ui/explorer-ui-tx-external-link'
import { useTranslation } from '@workspace/i18n'
import { Button } from '@workspace/ui/components/button'
import { UiEmpty } from '@workspace/ui/components/ui-empty'
import { UiError } from '@workspace/ui/components/ui-error'
import { useParams } from 'react-router'
import { PortfolioUiModal } from './ui/portfolio-ui-modal.tsx'

export function PortfolioFeatureModalComplete() {
  const { t } = useTranslation('portfolio')
  const { signature } = useParams<{ signature: string }>()

  if (!signature) {
    return <UiError message={new Error('Parameter signature is unknown')} title="No signature" />
  }
  assertIsSignature(signature)
  return (
    <PortfolioUiModal title={t(($) => $.actionConfirm)}>
      <UiEmpty className="border-solid" icon="checkCircle" iconClassName="text-green-500" title="Transaction complete!">
        <Button asChild>
          <ExplorerUiTxExternalLink signature={signature}>View in explorer</ExplorerUiTxExternalLink>
        </Button>
      </UiEmpty>
    </PortfolioUiModal>
  )
}
