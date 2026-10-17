import { formatNumber } from '@workspace/i18n/format'
import { bigIntToDecimal } from '@workspace/solana-client/big-int-to-decimal'

export function formatBalance({ balance = 0, decimals }: { balance: bigint | number | undefined; decimals: number }) {
  return formatNumber(bigIntToDecimal(balance, decimals), { maximumFractionDigits: decimals, minimumFractionDigits: 0 })
}
