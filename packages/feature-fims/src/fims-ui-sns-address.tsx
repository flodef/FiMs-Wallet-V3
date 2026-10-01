import { ellipsify } from '@workspace/ui/lib/ellipsify'
import { useSnsDomain } from './data-access/use-sns-domain.tsx'

// Displays a wallet's .sol name when SNS resolves one; falls back to a
// shortened base58 address. Purely presentational — the canonical address
// stays available via the title tooltip.
export function FimsUiSnsAddress({ address }: { address: string }) {
  const domain = useSnsDomain(address)
  return (
    <span className="font-mono text-xs" title={address}>
      {domain.data ?? ellipsify(address)}
    </span>
  )
}
