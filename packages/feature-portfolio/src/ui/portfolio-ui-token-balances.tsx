import { NATIVE_MINT } from '@workspace/solana-client/constants'
import type { TokenBalance } from '../data-access/use-get-token-balances.ts'

import { PortfolioUiTokenBalanceItem } from './portfolio-ui-token-balance-item.tsx'

export function PortfolioUiTokenBalances({ items }: { items: TokenBalance[] }) {
  // SOL is gas-only: it pays network fees and is never an investable asset,
  // so it does not appear as a portfolio line.
  return (
    <div className="space-y-2 md:space-y-6">
      {items
        .filter((item) => item.mint !== NATIVE_MINT)
        .map((item) => (
          <PortfolioUiTokenBalanceItem item={item} key={item.mint} showMenu />
        ))}
    </div>
  )
}
