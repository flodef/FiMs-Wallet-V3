import { type Address, isAddress } from '@solana/kit'
import { tryCatch } from '@workspace/core/try-catch'
import type { Account } from '@workspace/db/account/account'
import type { Network } from '@workspace/db/network/network'
import { i18n, useTranslation } from '@workspace/i18n'
import { isParsedTokenAccountData } from '@workspace/solana-client/get-token-account-info'
import type { GetTransactionSigner } from '@workspace/solana-client/transaction-signer'
import { uiAmountToBigInt } from '@workspace/solana-client/ui-amount-to-big-int'
import { useGetTokenAccountInfo } from '@workspace/solana-client-react/use-get-token-account-info'
import { useGetTokenMetadataJupiter } from '@workspace/solana-client-react/use-get-token-metadata-jupiter'
import { useSplTokenBurn } from '@workspace/solana-client-react/use-spl-token-burn'
import { UiError } from '@workspace/ui/components/ui-error'
import { UiLoader } from '@workspace/ui/components/ui-loader'
import { toastError } from '@workspace/ui/lib/toast-error'
import { useNavigate, useParams } from 'react-router'
import { burnValueAllowed } from './data-access/burn-rules.ts'
import { tokenValueEur, usePortfolioPricing } from './data-access/portfolio-pricing.tsx'
import { PortfolioUiBurn } from './ui/portfolio-ui-burn.tsx'
import { PortfolioUiModal } from './ui/portfolio-ui-modal.tsx'

export function PortfolioFeatureModalBurn({
  account,
  getTransactionSigner,
  network,
}: {
  account: Account
  getTransactionSigner: GetTransactionSigner
  network: Network
}) {
  const { t } = useTranslation('portfolio')
  const { address } = useParams<{ address: string }>()

  if (!address || !isAddress(address)) {
    return <UiError message={new Error(t(($) => $.errorNoAddressMessage))} title={t(($) => $.errorNoAddressTitle)} />
  }

  return (
    <PortfolioUiModal title={t(($) => $.actionBurn)}>
      {account.type === 'Watched' ? (
        <UiError
          message={new Error(t(($) => $.errorWatchedAccountMessage))}
          title={t(($) => $.errorWatchedAccountTitle)}
        />
      ) : (
        <PortfolioFeatureBurn address={address} getTransactionSigner={getTransactionSigner} network={network} />
      )}
    </PortfolioUiModal>
  )
}

function PortfolioFeatureBurn({
  address,
  getTransactionSigner,
  network,
}: {
  address: Address
  getTransactionSigner: GetTransactionSigner
  network: Network
}) {
  const { t } = useTranslation('portfolio')
  const navigate = useNavigate()
  const mutation = useSplTokenBurn({ network })
  const { data: dataTokenAccountInfo, isLoading: isLoadingTokenAccountInfo } = useGetTokenAccountInfo({
    address,
    network,
  })
  if (isLoadingTokenAccountInfo) {
    return <UiLoader />
  }
  if (!dataTokenAccountInfo?.exists || !dataTokenAccountInfo.data) {
    return (
      <UiError
        message={new Error(t(($) => $.errorNoTokenAccountInfoMessage))}
        title={t(($) => $.errorNoTokenAccountInfoTitle)}
      />
    )
  }
  if (!isParsedTokenAccountData(dataTokenAccountInfo.data)) {
    return (
      <UiError
        message={new Error(t(($) => $.errorInvalidTokenAccountMessage))}
        title={t(($) => $.errorInvalidTokenAccountTitle)}
      />
    )
  }
  if (!dataTokenAccountInfo.tokenProgram) {
    return (
      <UiError
        message={new Error(t(($) => $.errorUnsupportedTokenProgramMessage))}
        title={t(($) => $.errorUnsupportedTokenProgramTitle)}
      />
    )
  }

  const tokenAmount = dataTokenAccountInfo.data.tokenAmount
  const tokenProgram = dataTokenAccountInfo.tokenProgram
  const mint = dataTokenAccountInfo.data.mint
  return (
    <PortfolioFeatureBurnForm
      account={dataTokenAccountInfo.address}
      amount={tokenAmount.uiAmountString}
      balance={BigInt(tokenAmount.amount)}
      confirm={async (input) => {
        const { data: transactionSigner, error } = await tryCatch(getTransactionSigner())
        if (error) {
          toastError(i18n.t(($) => $.toastSignerUnavailable, { ns: 'ui' }))
          return
        }
        const { signature } = await mutation.mutateAsync({
          account: address,
          amount: uiAmountToBigInt(input.amount, tokenAmount.decimals),
          mint,
          tokenProgram,
          transactionSigner,
        })
        if (signature) {
          await navigate(`/modals/complete/${signature}`)
        }
      }}
      decimals={tokenAmount.decimals}
      isLoading={mutation.isPending}
      mint={mint}
    />
  )
}

// Prices the position before rendering the form: anything worth more than
// the burn threshold is refused here too — the deep link must not bypass
// the menu's dust-only rule.
function PortfolioFeatureBurnForm({
  account,
  amount,
  balance,
  decimals,
  isLoading,
  mint,
  confirm,
}: {
  account: Address
  amount: string
  balance: bigint
  decimals: number
  isLoading: boolean
  mint: Address
  confirm: (input: { account: Address; amount: string }) => Promise<void>
}) {
  const { t } = useTranslation('portfolio')
  const pricing = usePortfolioPricing()
  const metadata = useGetTokenMetadataJupiter([mint])
  const tokenMetadata = metadata.data?.[0] ?? pricing.metadata?.get(mint)
  const valueEur = tokenValueEur({ balance, decimals, mint, usdPrice: metadata.data?.[0]?.usdPrice }, pricing)

  if (metadata.isLoading) return <UiLoader />
  if (!burnValueAllowed(valueEur)) {
    return (
      <UiError
        message={
          new Error(
            t(($) => $.burnBlockedDescription, {
              value: valueEur === null ? '—' : pricing.format(valueEur),
            }),
          )
        }
        title={t(($) => $.burnBlockedTitle)}
      />
    )
  }

  const uiAmount = Number(amount)
  return (
    <PortfolioUiBurn
      account={account}
      amount={amount}
      confirm={confirm}
      isLoading={isLoading}
      pricePerUnitEur={valueEur !== null && uiAmount > 0 ? valueEur / uiAmount : null}
      symbol={tokenMetadata?.symbol ?? null}
    />
  )
}
