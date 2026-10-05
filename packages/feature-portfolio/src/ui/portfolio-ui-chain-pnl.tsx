import { useTranslation } from '@workspace/i18n'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@workspace/ui/components/table'
import type { TokenPnl } from '../data-access/chain-pnl.ts'

function usd(value: null | number | undefined): string {
  if (value === null || value === undefined) return '—'
  return `${value.toLocaleString(undefined, { maximumFractionDigits: 2 })} $`
}

function qty(value: number): string {
  return value.toLocaleString(undefined, { maximumFractionDigits: 4 })
}

function signedClass(value: null | number | undefined): string {
  if (value === null || value === undefined) return 'text-muted-foreground'
  return value >= 0 ? 'text-green-600' : 'text-red-600'
}

// Per-token P&L for the watched address. Only swap legs priced against
// stablecoins carry a USD value — unpriced moves stay quantity-only and the
// basis flag warns when sold quantity predates the synced history.
export function PortfolioUiChainPnl({ rows }: { rows: TokenPnl[] }) {
  const { t } = useTranslation('portfolio')
  if (!rows.length) return null
  return (
    <div className="space-y-2">
      <h3 className="font-semibold">{t(($) => $.chainPnlTitle)}</h3>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t(($) => $.chainPnlToken)}</TableHead>
            <TableHead className="text-right">{t(($) => $.chainPnlBought)}</TableHead>
            <TableHead className="text-right">{t(($) => $.chainPnlSold)}</TableHead>
            <TableHead className="text-right">{t(($) => $.chainPnlNet)}</TableHead>
            <TableHead className="text-right">{t(($) => $.chainPnlRealized)}</TableHead>
            <TableHead className="text-right">{t(($) => $.chainPnlUnrealized)}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <TableRow key={row.mint ?? 'SOL'}>
              <TableCell className="font-medium">
                {row.symbol}
                {!row.basisComplete ? (
                  <span className="ml-1 text-amber-600" title={t(($) => $.chainPnlPartialBasis)}>
                    *
                  </span>
                ) : null}
              </TableCell>
              <TableCell className="text-right font-mono text-xs">
                {qty(row.boughtQty)}
                {row.boughtUsd > 0 ? <div className="text-muted-foreground">{usd(row.boughtUsd)}</div> : null}
              </TableCell>
              <TableCell className="text-right font-mono text-xs">
                {qty(row.soldQty)}
                {row.soldUsd > 0 ? <div className="text-muted-foreground">{usd(row.soldUsd)}</div> : null}
              </TableCell>
              <TableCell className="text-right font-mono text-xs">{qty(row.netQty)}</TableCell>
              <TableCell className={`text-right font-mono text-xs ${signedClass(row.realizedUsd)}`}>
                {usd(row.realizedUsd)}
              </TableCell>
              <TableCell className={`text-right font-mono text-xs ${signedClass(row.unrealizedUsd)}`}>
                {usd(row.unrealizedUsd)}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )
}
