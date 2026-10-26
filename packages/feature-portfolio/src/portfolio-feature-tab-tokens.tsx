import type { Address } from '@solana/kit'
import type { Network } from '@workspace/db/network/network'
import { useTranslation } from '@workspace/i18n'
import { useGetAccountInfo } from '@workspace/solana-client-react/use-get-account-info'
import { Alert, AlertDescription, AlertTitle } from '@workspace/ui/components/alert'
import { Button } from '@workspace/ui/components/button'
import { UiIcon } from '@workspace/ui/components/ui-icon'
import { useMemo } from 'react'
import { PortfolioMemberHeader } from './data-access/portfolio-member-header.tsx'
import { usePortfolioPricing } from './data-access/portfolio-pricing.tsx'
import { useGetTokenBalancesState } from './data-access/use-get-token-balances.ts'
import { PortfolioUiAccountButtons } from './ui/portfolio-ui-account-buttons.tsx'
import { PortfolioUiBalance } from './ui/portfolio-ui-balance.tsx'
import { PortfolioUiBalanceSkeleton } from './ui/portfolio-ui-balance-skeleton.tsx'
import { PortfolioUiRequestAirdrop } from './ui/portfolio-ui-request-airdrop.tsx'
import { PortfolioUiTokenBalances } from './ui/portfolio-ui-token-balances.tsx'
import { PortfolioUiTokenBalancesSkeleton } from './ui/portfolio-ui-token-balances-skeleton.tsx'

export function PortfolioFeatureTabTokens({ address, network }: { address: Address; network: Network }) {
  const { t } = useTranslation('portfolio')
  const pricing = usePortfolioPricing()
  const { isError, isPartial, items: balances, refetch } = useGetTokenBalancesState({ address, network })
  const { data: dataWalletInfo, isLoading: isLoadingWalletInfo } = useGetAccountInfo({
    address,
    network,
  })
  const totalBalance = useMemo(
    () => pricing.format(balances.reduce((acc, item) => acc + (item.valueEur ?? 0), 0)),
    [balances, pricing],
  )

  return (
    <div className="space-y-2 px-2 md:space-y-6 md:px-0">
      {isLoadingWalletInfo ? <PortfolioUiBalanceSkeleton /> : <PortfolioUiBalance balance={totalBalance} />}

      <PortfolioMemberHeader address={address} />

      <PortfolioUiAccountButtons />

      {isError || isPartial ? (
        <Alert variant={isError ? 'destructive' : 'warning'}>
          <UiIcon icon="alert" />
          <AlertTitle>{t(($) => (isError ? $.balancesErrorTitle : $.balancesPartialTitle))}</AlertTitle>
          <AlertDescription className="flex flex-col items-start gap-2">
            {t(($) => (isError ? $.balancesErrorBody : $.balancesPartialBody))}
            <Button onClick={refetch} size="sm" variant="outline">
              {t(($) => $.balancesRetry)}
            </Button>
          </AlertDescription>
        </Alert>
      ) : null}

      {isLoadingWalletInfo ? null : (
        <PortfolioUiRequestAirdrop address={address} lamports={dataWalletInfo?.value?.lamports} network={network} />
      )}

      {isLoadingWalletInfo ? (
        <PortfolioUiTokenBalancesSkeleton length={3} />
      ) : (
        <PortfolioUiTokenBalances items={balances} />
      )}
    </div>
  )
}
