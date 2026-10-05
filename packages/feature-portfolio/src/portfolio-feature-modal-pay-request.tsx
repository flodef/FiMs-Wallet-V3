import type { Address } from '@solana/kit'
import { useMutation, useQuery } from '@tanstack/react-query'
import type { Network } from '@workspace/db/network/network'
import { useTranslation } from '@workspace/i18n'
import { assertSolanaPayTransactionSafe } from '@workspace/solana-client/assert-solana-pay-transaction-safe'
import { fetchSolanaPayRequest } from '@workspace/solana-client/fetch-solana-pay-request'
import { inspectWireTransaction } from '@workspace/solana-client/inspect-wire-transaction'
import { lamportsToSol } from '@workspace/solana-client/lamports-to-sol'
import { signAndSendWireTransaction } from '@workspace/solana-client/sign-and-send-wire-transaction'
import type { GetTransactionSigner } from '@workspace/solana-client/transaction-signer'
import { useSolanaClient } from '@workspace/solana-client-react/use-solana-client'
import { Button } from '@workspace/ui/components/button'
import { UiError } from '@workspace/ui/components/ui-error'
import { UiLoader } from '@workspace/ui/components/ui-loader'
import { ellipsify } from '@workspace/ui/lib/ellipsify'
import { useLocation, useNavigate } from 'react-router'
import { PortfolioUiModal } from './ui/portfolio-ui-modal.tsx'

// Transaction-request review screen: the merchant server was asked for a
// transaction (POST {account}), the wire bytes were decoded and simulated.
// The payer sees who asked and every balance change before signing.
export function PortfolioFeatureModalPayRequest({
  address,
  getTransactionSigner,
  network,
}: {
  address: Address
  getTransactionSigner: GetTransactionSigner
  network: Network
}) {
  const { t } = useTranslation('portfolio')
  const location = useLocation()
  const navigate = useNavigate()
  const client = useSolanaClient({ network })
  const { from, link } = (location.state as { from?: string; link?: string } | null) ?? {}

  const query = useQuery({
    enabled: !!link,
    queryFn: async () => {
      const resolution = await fetchSolanaPayRequest(link as string, address)
      const inspection = await inspectWireTransaction(client, resolution.transaction)
      assertSolanaPayTransactionSafe({ account: address, inspection })
      return { inspection, resolution }
    },
    queryKey: ['solana-pay-request', link, address, network.endpoint],
  })

  const sendMutation = useMutation({
    mutationFn: async () => {
      if (!query.data) {
        throw new Error('No resolved transaction to sign')
      }
      const signer = await getTransactionSigner()
      return signAndSendWireTransaction(client, query.data.resolution.transaction, signer)
    },
    onSuccess: async (signature) => {
      await navigate(`/modals/complete/${signature}`)
    },
  })

  if (!link) {
    return (
      <PortfolioUiModal title={t(($) => $.payTitle)}>
        <UiError message={new Error('Missing payment link')} title={t(($) => $.payTitle)} />
      </PortfolioUiModal>
    )
  }

  const data = query.data
  const merchant = data?.resolution.merchant
  const host = (() => {
    try {
      return new URL(link).host
    } catch {
      return link
    }
  })()

  const solChanges =
    data?.inspection.simulation.solBalanceChanges.filter((change) => change.address === address && change.change) ?? []
  const tokenChanges =
    data?.inspection.simulation.tokenBalanceChanges.filter((change) => change.owner === address && change.change) ?? []

  return (
    <PortfolioUiModal title={t(($) => $.payTitle)}>
      {query.isPending ? (
        <div className="flex items-center gap-2 rounded-md border p-3 text-muted-foreground text-sm">
          <UiLoader className="size-4" />
          {t(($) => $.payResolving)}
        </div>
      ) : query.error || sendMutation.error ? (
        <UiError message={(sendMutation.error ?? query.error) as Error} title={t(($) => $.payRequestFailed)} />
      ) : data ? (
        <div className="space-y-4">
          <div className="space-y-1 rounded-md border p-3 text-sm">
            {merchant?.icon ? (
              <img alt="" className="mb-2 size-10 rounded-md object-cover" src={merchant.icon} />
            ) : null}
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">{t(($) => $.payRequestMerchant)}</span>
              <span>{merchant?.label ?? host}</span>
            </div>
            {merchant?.label ? (
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">{t(($) => $.payRequestHost)}</span>
                <span className="font-mono text-xs">{host}</span>
              </div>
            ) : null}
            {data.resolution.message ? (
              <div className="flex items-center justify-between gap-3">
                <span className="text-muted-foreground">{t(($) => $.payMessage)}</span>
                <span className="text-right">{data.resolution.message}</span>
              </div>
            ) : null}
          </div>

          <div className="space-y-1 rounded-md border p-3 text-sm">
            <div className="text-muted-foreground">{t(($) => $.payRequestChanges)}</div>
            {solChanges.map((change) => (
              <div className="flex items-center justify-between font-mono" key={`sol-${change.address}`}>
                <span>SOL</span>
                <span className={change.change < 0n ? 'text-destructive' : 'text-green-600'}>
                  {change.change > 0n ? '+' : ''}
                  {lamportsToSol(change.change)}
                </span>
              </div>
            ))}
            {tokenChanges.map((change) => (
              <div className="flex items-center justify-between font-mono" key={`${change.account}-${change.mint}`}>
                <span>{ellipsify(change.mint)}</span>
                <span className={change.change < 0n ? 'text-destructive' : 'text-green-600'}>
                  {change.change > 0n ? '+' : ''}
                  {lamportsToSol(change.change, change.decimals)}
                </span>
              </div>
            ))}
            {!solChanges.length && !tokenChanges.length ? (
              <div className="text-muted-foreground">{t(($) => $.payRequestNoChanges)}</div>
            ) : null}
            {data.inspection.simulation.fee !== undefined ? (
              <div className="flex items-center justify-between border-t pt-1 font-mono text-xs">
                <span className="text-muted-foreground">{t(($) => $.sendConfirmNetworkFee)}</span>
                <span>{lamportsToSol(data.inspection.simulation.fee)} SOL</span>
              </div>
            ) : null}
          </div>

          <div className="flex gap-2">
            <Button
              className="flex-1"
              disabled={sendMutation.isPending}
              onClick={() => navigate(from ?? '/portfolio')}
              variant="outline"
            >
              {t(($) => $.payRequestDecline)}
            </Button>
            <Button className="flex-1" disabled={sendMutation.isPending} onClick={() => sendMutation.mutate()}>
              {sendMutation.isPending ? <UiLoader className="size-4" /> : null}
              {t(($) => $.payRequestSignAndSend)}
            </Button>
          </div>
        </div>
      ) : null}
    </PortfolioUiModal>
  )
}
