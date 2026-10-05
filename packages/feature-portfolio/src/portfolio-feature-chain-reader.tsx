import type { Account } from '@workspace/db/account/account'
import type { Network } from '@workspace/db/network/network'
import { useTranslation } from '@workspace/i18n'
import { Button } from '@workspace/ui/components/button'
import { Input } from '@workspace/ui/components/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@workspace/ui/components/select'
import { Spinner } from '@workspace/ui/components/spinner'
import { UiCard } from '@workspace/ui/components/ui-card'
import { UiIcon } from '@workspace/ui/components/ui-icon'
import { useMemo, useState } from 'react'
import { aggregateTokenFlows, computeTokenPnl } from './data-access/chain-pnl.ts'
import { useChainAssets, useChainHistory, useChainLabels } from './data-access/use-chain-reader.ts'
import { PortfolioUiChainPnl } from './ui/portfolio-ui-chain-pnl.tsx'
import { PortfolioUiChainTxList } from './ui/portfolio-ui-chain-tx-list.tsx'

const KIND_ORDER: Record<string, number> = { cex: 3, member: 2, other: 4, tontine: 1, treasury: 0 }

// On-chain tx reader: pick any watched address (own account by default), sync
// its normalized history through the API's Helius proxy into the Dexie cache,
// and render a human-readable ledger with per-token P&L.
export function PortfolioFeatureChainReader({ account, network }: { account: Account; network: Network }) {
  const { t } = useTranslation('portfolio')
  const [address, setAddress] = useState<string>(account.publicKey)
  const [custom, setCustom] = useState('')

  const labels = useChainLabels({ account })
  const history = useChainHistory({ account, address })
  const assets = useChainAssets({ account, address })

  const options = useMemo(() => {
    const rows = (labels.data ?? []).slice().sort((a, b) => (KIND_ORDER[a.kind] ?? 9) - (KIND_ORDER[b.kind] ?? 9))
    return rows
  }, [labels.data])

  const pnl = useMemo(() => {
    if (!history.data) return []
    const prices = new Map<string, number>()
    for (const asset of assets.data ?? []) {
      if (asset.usdPrice !== null) prices.set(asset.mint ?? 'SOL', asset.usdPrice)
    }
    return computeTokenPnl(aggregateTokenFlows(history.data), prices)
  }, [history.data, assets.data])

  const signable = account.type !== 'Watched'

  return (
    <UiCard
      action={
        <Button
          disabled={!signable || history.isFetching}
          onClick={() => history.refetch()}
          size="icon"
          variant="outline"
        >
          {history.isFetching ? <Spinner /> : <UiIcon icon="refresh" />}
        </Button>
      }
      title={<div>{t(($) => $.chainReaderTitle)}</div>}
    >
      <div className="space-y-4">
        <div className="flex flex-col gap-2 md:flex-row">
          <Select onValueChange={(value) => setAddress(value === 'custom' ? custom : value)} value={address}>
            <SelectTrigger className="w-full md:w-72">
              <SelectValue placeholder={t(($) => $.chainReaderAddress)} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={account.publicKey}>{t(($) => $.chainReaderThisAccount)}</SelectItem>
              {options.map((option) => (
                <SelectItem key={option.address} value={option.address}>
                  {option.label}
                </SelectItem>
              ))}
              <SelectItem value="custom">{t(($) => $.chainReaderCustom)}</SelectItem>
            </SelectContent>
          </Select>
          {!options.some((o) => o.address === address) && address !== account.publicKey ? (
            <Input
              className="font-mono text-xs md:w-96"
              onBlur={() => setAddress(custom || account.publicKey)}
              onChange={(event) => setCustom(event.target.value)}
              placeholder={t(($) => $.chainReaderCustomAddress)}
              value={custom}
            />
          ) : null}
        </div>

        {!signable ? <div className="text-muted-foreground text-sm">{t(($) => $.chainReaderWatched)}</div> : null}
        {history.isError ? <pre className="alert alert-error whitespace-pre-wrap">{history.error.message}</pre> : null}
        {history.isLoading ? (
          <div className="flex items-center gap-2 text-muted-foreground">
            <Spinner /> {t(($) => $.chainReaderSyncing)}
          </div>
        ) : null}
        {history.data ? (
          <>
            <PortfolioUiChainPnl rows={pnl} />
            <PortfolioUiChainTxList from="/portfolio" network={network} transactions={history.data} />
          </>
        ) : null}
      </div>
    </UiCard>
  )
}
