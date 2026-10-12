import { useNetworkActive } from '@workspace/db-react/use-network-active'
import { useSetting } from '@workspace/db-react/use-setting'
import type { GetActivityItem } from '@workspace/solana-client/get-activity'
import { type ExplorerProvider, explorerProviders, getExplorerUrl } from '@workspace/solana-client/get-explorer-url'
import { ellipsify } from '@workspace/ui/lib/ellipsify'

// A tx signature that opens in the user's chosen external explorer
// (chainExplorer setting: Orb / Solscan / Solana Explorer — cluster-aware).
export function PortfolioUiTxLink({ tx }: { tx: GetActivityItem }) {
  const network = useNetworkActive()
  const [explorer] = useSetting('chainExplorer')
  const provider: ExplorerProvider = explorerProviders.includes(explorer as ExplorerProvider)
    ? (explorer as ExplorerProvider)
    : 'solana'
  return (
    <a
      className="cursor-pointer font-mono text-sm hover:underline"
      href={getExplorerUrl({ network, path: `/tx/${tx.signature}`, provider })}
      rel="noopener noreferrer"
      target="_blank"
    >
      {ellipsify(tx.signature, 8)}
    </a>
  )
}
