import { type Address, assertIsAddress } from '@solana/kit'
import type { Network } from '@workspace/db/network/network'
import { useTranslation } from '@workspace/i18n'
import { bigIntToDecimal } from '@workspace/solana-client/big-int-to-decimal'
import { NATIVE_MINT } from '@workspace/solana-client/constants'
import type { GetTransactionSigner } from '@workspace/solana-client/transaction-signer'
import { useSimulatePreparedTransaction } from '@workspace/solana-client-react/use-simulate-prepared-transaction'
import { UiError } from '@workspace/ui/components/ui-error'
import { ellipsify } from '@workspace/ui/lib/ellipsify'
import { useLocation, useNavigate, useParams } from 'react-router'
import { getAmountForMint } from './data-access/get-amount-for-mint.ts'
import { usePortfolioTokenMint } from './data-access/use-portfolio-token-mint.tsx'
import { type PortfolioPreparedTransaction, usePortfolioTxPrepare } from './data-access/use-portfolio-tx-prepare.tsx'
import { usePortfolioTxSend } from './data-access/use-portfolio-tx-send.tsx'
import type { SolanaPayRequestState } from './data-access/use-solana-pay-request.tsx'
import type {
  SendBlockContext,
  SendExtraRecipient,
  SendFeeContext,
  SendOverrideContext,
  SendSolFee,
} from './portfolio-modals.tsx'
import { PortfolioUiModal } from './ui/portfolio-ui-modal.tsx'
import { PortfolioUiSendConfirm } from './ui/portfolio-ui-send-confirm.tsx'

export function PortfolioFeatureModalConfirm({
  address,
  getSendBlock,
  getSendExtraRecipients,
  getSendFee,
  getTransactionSigner,
  network,
  renderSendOverride,
}: {
  address: Address
  // Returns a user-facing message when this send must be blocked
  // (e.g. FiMs debt guard, configured send cap), or null/undefined to allow it.
  getSendBlock?: ((send: SendBlockContext) => null | string) | undefined
  // Extra token recipients carved out of the sent amount (e.g. the FiMs
  // tontine share): the destination receives the remainder of the entered
  // amount. Skipped for Solana Pay requests, which expect an exact amount.
  getSendExtraRecipients?: ((send: SendFeeContext) => SendExtraRecipient[] | null | undefined) | undefined
  // Optional SOL-denominated service fee appended to the send transaction,
  // computed on the amount actually delivered to the destination.
  getSendFee?: ((send: SendFeeContext) => SendSolFee | null | undefined) | undefined
  getTransactionSigner: GetTransactionSigner
  network: Network
  // Replacement confirmation view for sends needing special handling
  // (auto-conversion); null falls through to the normal confirm.
  renderSendOverride?: ((send: SendOverrideContext) => React.ReactNode) | undefined
}) {
  const { t } = useTranslation('portfolio')
  const { amount, destination, token } = useParams<{ amount: string; destination: string; token: string }>()
  const mint = usePortfolioTokenMint({ address, network, token })
  const navigate = useNavigate()
  // Solana Pay request fields carried from the pay/scan entry points.
  const payRequest = (useLocation().state as SolanaPayRequestState | null)?.payRequest
  const enteredAmount = amount && mint ? getAmountForMint({ amount, mint }) : undefined
  const extraRecipients =
    !payRequest && amount && destination && mint && getSendExtraRecipients
      ? getSendExtraRecipients({ amount, destination: destination as Address, mint })
      : undefined
  const extraTotal = extraRecipients?.reduce((sum, r) => sum + r.amount, 0n) ?? 0n
  // Carved extras are always deducted — a fallback to the entered amount when
  // they reach it would double-spend (dest + carve on the same balance).
  const netAmount = enteredAmount != null ? enteredAmount - extraTotal : undefined
  const recipients =
    netAmount != null && destination
      ? [
          // A carve can consume the whole send (exit rule) — no zero recipient.
          ...(netAmount > 0n ? [{ amount: netAmount, destination: destination as Address }] : []),
          ...(extraRecipients ?? []),
        ]
      : undefined
  const sendFee =
    amount && destination && mint && netAmount != null && getSendFee
      ? getSendFee({
          amount: bigIntToDecimal(netAmount, mint.mint === NATIVE_MINT ? 9 : mint.decimals).toString(),
          destination: destination as Address,
          mint,
        })
      : undefined
  const solFee = sendFee ? { amount: sendFee.lamports, destination: sendFee.destination } : undefined
  const confirmMutation = usePortfolioTxSend({ network })
  const prepareQuery = usePortfolioTxPrepare({
    getTransactionSigner,
    input:
      mint && recipients
        ? {
            memo: payRequest?.memo,
            mint,
            recipients,
            references: payRequest?.references,
            solFee,
          }
        : undefined,
    network,
    transactionSignerAddress: address,
  })
  const simulationQuery = useSimulatePreparedTransaction({
    input: prepareQuery.data,
    network,
  })
  const confirmSimulation =
    isMatchingPreparedTransaction(confirmMutation.variables, prepareQuery.data) &&
    confirmMutation.data?.simulation.status === 'failure'
      ? confirmMutation.data.simulation
      : undefined
  const simulation = confirmSimulation ?? simulationQuery.data

  if (!token) {
    return <UiError message={new Error('Token parameter is unknown')} title="No token" />
  }

  if (!mint) {
    return <UiError message={new Error(`Token with mint ${ellipsify(token)} not found`)} title="Token not found" />
  }

  if (!amount) {
    return <UiError message={new Error('Parameter amount is unknown')} title="No amount" />
  }

  if (!destination) {
    return <UiError message={new Error('Parameter destination is unknown')} title="No destination" />
  }
  assertIsAddress(destination)
  const sendBlock = getSendBlock?.({ amount, destination: destination as Address, mint: mint.mint })
  if (sendBlock) {
    return (
      <PortfolioUiModal title={t(($) => $.actionSend)}>
        <UiError message={new Error(sendBlock)} title="Send blocked" />
      </PortfolioUiModal>
    )
  }
  const sendOverride = renderSendOverride?.({
    amount,
    destination: destination as Address,
    mint,
  })
  if (sendOverride) {
    return <PortfolioUiModal title={t(($) => $.actionConfirm)}>{sendOverride}</PortfolioUiModal>
  }
  if (prepareQuery.error) {
    return <UiError message={prepareQuery.error} title="Transaction preview failed" />
  }
  return (
    <PortfolioUiModal title={t(($) => $.actionConfirm)}>
      <PortfolioUiSendConfirm
        confirm={async (input) => {
          const result = await confirmMutation.mutateAsync(input)
          if (result?.signature) {
            await navigate(`/modals/complete/${result.signature}`)
          }
          return result
        }}
        isLoading={confirmMutation.isPending}
        isPreparing={prepareQuery.isLoading}
        isSimulating={simulationQuery.isFetching || simulationQuery.isLoading}
        mint={mint}
        preparedTransaction={prepareQuery.data}
        recipients={recipients ?? []}
        simulation={simulation}
        simulationError={simulationQuery.error}
        solFeeLamports={sendFee?.lamports}
      />
    </PortfolioUiModal>
  )
}

function isMatchingPreparedTransaction(
  transactionA: PortfolioPreparedTransaction | undefined,
  transactionB: PortfolioPreparedTransaction | undefined,
) {
  if (!transactionA || !transactionB) {
    return false
  }

  return (
    transactionA.mint.mint === transactionB.mint.mint &&
    transactionA.recipients.length === transactionB.recipients.length &&
    transactionA.recipients.every((recipient, index) => {
      const otherRecipient = transactionB.recipients[index]

      return otherRecipient?.amount === recipient.amount && otherRecipient.destination === recipient.destination
    }) &&
    transactionA.transactionSigner.address === transactionB.transactionSigner.address
  )
}
