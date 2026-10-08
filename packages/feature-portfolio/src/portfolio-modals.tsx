import type { Address } from '@solana/kit'
import type { Network } from '@workspace/db/network/network'
import { useAccountActive } from '@workspace/db-react/use-account-active'
import { useAccountGetTransactionSigner } from '@workspace/db-react/use-account-get-transaction-signer'
import { useNetworkActive } from '@workspace/db-react/use-network-active'
import { useTranslation } from '@workspace/i18n'
import type { UiGroupedComboboxInputGroup } from '@workspace/ui/components/ui-grouped-combobox-input'
import { UiNotFound } from '@workspace/ui/components/ui-not-found'
import { useRoutes } from 'react-router'
import type { TokenBalance } from './data-access/use-get-token-balances.ts'
import { PortfolioFeatureModalBurn } from './portfolio-feature-modal-burn.tsx'
import { PortfolioFeatureModalComplete } from './portfolio-feature-modal-complete.tsx'
import { PortfolioFeatureModalConfirm } from './portfolio-feature-modal-confirm.tsx'
import { PortfolioFeatureModalPay } from './portfolio-feature-modal-pay.tsx'
import { PortfolioFeatureModalPayRequest } from './portfolio-feature-modal-pay-request.tsx'
import { PortfolioFeatureModalReceive } from './portfolio-feature-modal-receive.tsx'
import { PortfolioFeatureModalSelectAmount } from './portfolio-feature-modal-select-amount.tsx'
import { PortfolioFeatureModalSelectDestination } from './portfolio-feature-modal-select-destination.tsx'
import { PortfolioFeatureModalSelectTokens } from './portfolio-feature-modal-select-tokens.tsx'
import { PortfolioUiModal } from './ui/portfolio-ui-modal.tsx'
import type { DestinationAccount } from './ui/portfolio-ui-send-destination.tsx'

export interface SendBlockContext {
  // Amount in token UI units (the value the user typed)
  amount: string
  destination: Address
  mint: Address
}

export interface SendOverrideContext {
  amount: string
  destination: Address
  mint: TokenBalance
}

export interface SendFeeContext {
  amount: string
  destination: Address
  mint: TokenBalance
}

// Optional SOL-denominated fee appended to the send transaction (e.g. the FiMs
// operating fee): an extra lamports transfer injected at prepare time.
export interface SendSolFee {
  destination: Address
  lamports: bigint
}

// Extra token recipient carved OUT of the sent amount (e.g. the FiMs tontine
// share): it is part of the same transaction but the destination receives the
// remainder, so the member's total spend stays the entered amount.
export interface SendExtraRecipient {
  amount: bigint
  destination: Address
}

export default function PortfolioModals({
  extraDestinationGroups,
  getSendBlock,
  getSendExtraRecipients,
  getSendFee,
  renderSendDestination,
  renderSendOverride,
}: {
  extraDestinationGroups?: UiGroupedComboboxInputGroup<DestinationAccount>[] | undefined
  getSendBlock?: ((send: SendBlockContext) => null | string) | undefined
  getSendExtraRecipients?: ((send: SendFeeContext) => SendExtraRecipient[] | null | undefined) | undefined
  getSendFee?: ((send: SendFeeContext) => SendSolFee | null | undefined) | undefined
  // When a send needs special handling (e.g. auto-conversion for a restricted
  // destination), return the replacement confirmation view; null = normal send.
  // When set, replaces the destination step of the send flow entirely —
  // used by FiMs for its guided exchange picker.
  renderSendDestination?: ((props: { address: Address; network: Network }) => React.ReactNode) | undefined
  renderSendOverride?: ((send: SendOverrideContext) => React.ReactNode) | undefined
}) {
  const { t } = useTranslation('ui')
  const account = useAccountActive()
  const network = useNetworkActive()
  const getTransactionSigner = useAccountGetTransactionSigner({ account })

  return useRoutes([
    {
      element: (
        <PortfolioFeatureModalBurn account={account} getTransactionSigner={getTransactionSigner} network={network} />
      ),
      path: 'burn/:address',
    },
    {
      element: (
        <PortfolioFeatureModalConfirm
          address={account.publicKey}
          getSendBlock={getSendBlock}
          getSendExtraRecipients={getSendExtraRecipients}
          getSendFee={getSendFee}
          getTransactionSigner={getTransactionSigner}
          network={network}
          renderSendOverride={renderSendOverride}
        />
      ),
      path: 'confirm/:token/:destination/:amount',
    },
    { element: <PortfolioFeatureModalComplete />, path: 'complete/:signature' },
    { element: <PortfolioFeatureModalPay />, path: 'pay' },
    {
      element: (
        <PortfolioFeatureModalPayRequest
          address={account.publicKey}
          getTransactionSigner={getTransactionSigner}
          network={network}
        />
      ),
      path: 'pay-request',
    },
    { element: <PortfolioFeatureModalReceive account={account} />, path: 'receive' },
    { element: <PortfolioFeatureModalSelectTokens account={account} network={network} />, path: 'send' },
    {
      element: renderSendDestination ? (
        renderSendDestination({ address: account.publicKey as Address, network })
      ) : (
        <PortfolioFeatureModalSelectDestination
          address={account.publicKey}
          extraGroups={extraDestinationGroups}
          network={network}
        />
      ),
      path: 'send/:token',
    },
    {
      element: <PortfolioFeatureModalSelectAmount address={account.publicKey} network={network} />,
      path: 'send/:token/:destination',
    },
    {
      element: (
        <PortfolioUiModal title={t(($) => $.notFoundTitle)}>
          <UiNotFound />
        </PortfolioUiModal>
      ),
      path: '*',
    },
  ])
}
