import { useNetworkActive } from '@workspace/db-react/use-network-active'
import { useSetting } from '@workspace/db-react/use-setting'
import { type ExplorerProvider, explorerProviders, getExplorerUrl } from '@workspace/solana-client/get-explorer-url'
import { cn } from '@workspace/ui/lib/utils'
import type { ReactNode } from 'react'

// A signature → external explorer link honouring the chainExplorer setting
// (Orb / Solscan / Solana Explorer, cluster-aware).
export function ExplorerUiTxExternalLink({
  children,
  className,
  signature,
}: {
  children?: ReactNode
  className?: string
  signature: string
}) {
  const network = useNetworkActive()
  const [explorer] = useSetting('chainExplorer')
  const provider: ExplorerProvider = explorerProviders.includes(explorer as ExplorerProvider)
    ? (explorer as ExplorerProvider)
    : 'solana'
  return (
    <a
      className={cn('cursor-pointer', className)}
      href={getExplorerUrl({ network, path: `/tx/${signature}`, provider })}
      rel="noopener noreferrer"
      target="_blank"
    >
      {children}
    </a>
  )
}
