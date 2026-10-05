import type { Network } from '@workspace/db/network/network'
import { ExplorerUiExplorerIcon } from '@workspace/feature-explorer/ui/explorer-ui-explorer-icon'
import { useTranslation } from '@workspace/i18n'
import { Badge } from '@workspace/ui/components/badge'
import { UiIcon } from '@workspace/ui/components/ui-icon'
import type { UiIconName } from '@workspace/ui/components/ui-icon-map'
import { UiRelativeDate } from '@workspace/ui/components/ui-relative-date'
import type { ChainTransaction } from '../data-access/chain-api.ts'
import { type ChainTxKind, chainTxNetAmounts, chainTxPeer, classifyChainTx } from '../data-access/chain-classify.ts'

const KIND_ICON: Record<ChainTxKind, UiIconName> = {
  deposit: 'arrowDown',
  donation: 'handCoins',
  other: 'coins',
  swap: 'refresh',
  transfer: 'explorer',
  withdrawal: 'arrowUp',
}

const KIND_STYLE: Record<ChainTxKind, string> = {
  deposit: 'text-green-600',
  donation: 'text-amber-600',
  other: 'text-muted-foreground',
  swap: 'text-blue-600',
  transfer: 'text-muted-foreground',
  withdrawal: 'text-red-600',
}

function formatAmount(amount: number): string {
  const abs = Math.abs(amount)
  const digits = abs >= 1000 ? 2 : abs >= 1 ? 4 : 6
  return amount.toLocaleString(undefined, { maximumFractionDigits: digits })
}

function ChainTxItem({ network, tx }: { network: Network; tx: ChainTransaction }) {
  const { t } = useTranslation('portfolio')
  const kind = classifyChainTx(tx)
  const peer = chainTxPeer(tx)
  const amounts = chainTxNetAmounts(tx)
  // Explicit keys: the i18n extractor needs static `t(($) => $…)` calls on the
  // namespaced `t`, so the switch lives inside the component.
  const kindLabel = (() => {
    switch (kind) {
      case 'deposit':
        return t(($) => $.chainKindDeposit)
      case 'donation':
        return t(($) => $.chainKindDonation)
      case 'swap':
        return t(($) => $.chainKindSwap)
      case 'transfer':
        return t(($) => $.chainKindTransfer)
      case 'withdrawal':
        return t(($) => $.chainKindWithdrawal)
      default:
        return t(($) => $.chainKindOther)
    }
  })()
  return (
    <div className="flex items-center justify-between gap-2 py-1">
      <div className="flex min-w-0 items-center gap-2">
        <UiIcon className={`size-4 shrink-0 ${KIND_STYLE[kind]}`} icon={KIND_ICON[kind]} />
        <Badge className="shrink-0 capitalize" variant="outline">
          {kindLabel}
        </Badge>
        <div className="flex min-w-0 flex-col">
          <div className="truncate font-mono text-sm">
            {amounts.map(({ amount, symbol }) => (
              <span className={amount >= 0 ? 'text-green-600' : 'text-red-600'} key={symbol}>
                {amount >= 0 ? '+' : ''}
                {formatAmount(amount)} {symbol}{' '}
              </span>
            ))}
          </div>
          <div className="truncate text-muted-foreground text-xs">
            {peer ?? t(($) => $.chainKindOther)}
            {tx.feeSol > 0 ? ` · ${t(($) => $.chainFee)} ${tx.feeSol.toFixed(6)} SOL` : ''}
          </div>
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2 font-mono text-muted-foreground text-xs">
        <UiRelativeDate date={new Date(tx.timestamp * 1000)} />
        <ExplorerUiExplorerIcon network={network} path={`/tx/${tx.signature}`} provider="solana" />
      </div>
    </div>
  )
}

export function PortfolioUiChainTxList({
  network,
  transactions,
}: {
  from?: string
  network: Network
  transactions: ChainTransaction[]
}) {
  const { t } = useTranslation('portfolio')
  if (!transactions.length) {
    return <div className="text-muted-foreground text-sm">{t(($) => $.chainReaderEmpty)}</div>
  }
  return (
    <div className="divide-y">
      {transactions.map((tx) => (
        <ChainTxItem key={tx.signature} network={network} tx={tx} />
      ))}
    </div>
  )
}
