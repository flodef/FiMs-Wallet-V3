import { ExplorerUiTxExternalLink } from '@workspace/feature-explorer/ui/explorer-ui-tx-external-link'
import { useTranslation } from '@workspace/i18n'
import { formatNumber } from '@workspace/i18n/format'
import { Badge } from '@workspace/ui/components/badge'
import { Button } from '@workspace/ui/components/button'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@workspace/ui/components/table'
import { UiIcon } from '@workspace/ui/components/ui-icon'
import { useMemo, useState } from 'react'
import type { FimsToken, FimsTransaction } from './fims-api.ts'
import { formatDate } from './fims-format.ts'
import { getFimsTransactionType } from './fims-transaction-type.ts'
import type { FimsTxGroup } from './fims-tx-groups.ts'
import { FimsTxTypeLabel } from './fims-tx-type-label.tsx'

// v1 transactions explorer: clickable per-type summary chips, cross-filters
// (each dimension's options come from the rows selected by the OTHER
// filters), sortable columns and per-transaction profit vs the current
// price — profit = price_now × amount − movement − cost (0 on
// donation/payment rows). Click a row to expand rate + profit details.
export function FimsUiTxExplorer({
  format,
  groups,
  tokens,
}: {
  format: (value: number) => string
  groups: FimsTxGroup[]
  tokens: FimsToken[]
}) {
  const { t } = useTranslation('fims')
  const priceBySymbol = useMemo(() => new Map(tokens.map((token) => [token.symbol, token.value])), [tokens])

  const rows = useMemo(() => {
    return groups.map((group) => {
      const [first] = group.legs
      const type = getFimsTransactionType(first)
      const movement = group.legs.reduce((sum, leg) => sum + leg.movement, 0)
      const cost = group.legs.reduce((sum, leg) => sum + leg.cost, 0)
      const profit = group.legs.reduce((sum, leg) => {
        if (type === 'donation' || type === 'payment' || leg.amount == null || leg.token == null) return sum
        const price = priceBySymbol.get(leg.token)
        if (price == null) return sum
        return sum + price * Number(leg.amount) - leg.movement - leg.cost
      }, 0)
      return {
        cost,
        date: first.date,
        group,
        id: first.id,
        movement,
        profit,
        signature: group.legs.find((leg) => leg.signature)?.signature ?? null,
        tokens: [...new Set(group.legs.map((leg) => leg.token).filter((token): token is string => token != null))],
        type,
      }
    })
  }, [groups, priceBySymbol])

  const [years, setYears] = useState<Set<number>>(new Set())
  const [mags, setMags] = useState<Set<number>>(new Set())
  const [types, setTypes] = useState<Set<string>>(new Set())
  const [tokenFilter, setTokenFilter] = useState<Set<string>>(new Set())
  const [sort, setSort] = useState<{ key: 'date' | 'movement' | 'profit' | 'token' | 'type'; dir: 1 | -1 }>({
    dir: -1,
    key: 'date',
  })
  const [expanded, setExpanded] = useState<number | null>(null)

  const yearOf = (row: (typeof rows)[number]) => new Date(row.date).getFullYear()
  const magOf = (row: (typeof rows)[number]) => Math.floor(Math.log10(Math.max(1, Math.abs(row.movement))))

  // Cross-filter: dimension options are computed on rows filtered by the
  // other dimensions only — options never disappear under their own filter.
  const filteredBy = (exclude: 'mag' | 'token' | 'type' | 'year' | null) =>
    rows.filter(
      (row) =>
        (exclude === 'year' || years.size === 0 || years.has(yearOf(row))) &&
        (exclude === 'mag' || mags.size === 0 || mags.has(magOf(row))) &&
        (exclude === 'type' || types.size === 0 || types.has(row.type)) &&
        (exclude === 'token' || tokenFilter.size === 0 || row.tokens.some((token) => tokenFilter.has(token))),
    )

  const dir = sort.dir
  const visible = filteredBy(null).sort((a, b) => {
    switch (sort.key) {
      case 'date':
        return (a.date < b.date ? -1 : a.date > b.date ? 1 : 0) * dir
      case 'movement':
        return (a.movement - b.movement) * dir
      case 'profit':
        return (a.profit - b.profit) * dir
      case 'token':
        return (a.tokens[0] ?? '').localeCompare(b.tokens[0] ?? '') * dir
      case 'type':
        return a.type.localeCompare(b.type) * dir
      default:
        return 0
    }
  })

  const hasFilters = years.size > 0 || mags.size > 0 || types.size > 0 || tokenFilter.size > 0
  const resetFilters = () => {
    setYears(new Set())
    setMags(new Set())
    setTypes(new Set())
    setTokenFilter(new Set())
  }
  const toggle = <V,>(set: Set<V>, value: V, apply: (s: Set<V>) => void) => {
    const next = new Set(set)
    if (next.has(value)) next.delete(value)
    else next.add(value)
    apply(next)
  }

  const typeOptions = [...new Set(filteredBy('type').map((row) => row.type))].sort()
  const yearOptions = [...new Set(filteredBy('year').map(yearOf))].sort((a, b) => b - a)
  const magOptions = [...new Set(filteredBy('mag').map(magOf))].sort((a, b) => a - b)
  const tokenOptions = [...new Set(filteredBy('token').flatMap((row) => row.tokens))].sort()

  const typeFiltered = filteredBy('type')
  const sumMovement = new Map<string, typeof rows>(
    typeOptions.map((type) => [type, typeFiltered.filter((r) => r.type === type)]),
  )
  const fees = filteredBy(null).reduce((sum, row) => sum + (row.cost < 0 ? row.cost : 0), 0)
  const profitTotal = types.has('donation') ? null : filteredBy(null).reduce((sum, row) => sum + row.profit, 0)
  const grandTotal = filteredBy(null).reduce((sum, row) => sum + row.movement, 0)

  const sortIcon = (key: typeof sort.key) =>
    sort.key === key ? <UiIcon className="ml-1 inline size-3" icon={sort.dir === 1 ? 'arrowUp' : 'arrowDown'} /> : null
  const onSort = (key: typeof sort.key) =>
    setSort((current) => ({ dir: current.key === key && current.dir === -1 ? 1 : -1, key }))

  return (
    <div className="space-y-3">
      {/* Clickable summary — each chip is also the type filter. */}
      <div className="flex flex-wrap gap-1.5">
        {typeOptions.map((type) => {
          const legs = sumMovement.get(type) ?? []
          const sum = legs.reduce((s, r) => s + r.movement, 0)
          const active = types.has(type)
          return (
            <Badge
              className="cursor-pointer"
              key={type}
              onClick={() => toggle(types, type, setTypes)}
              variant={active ? 'default' : 'outline'}
            >
              {type} · {legs.length} · {format(sum)}
            </Badge>
          )
        })}
        {profitTotal !== null ? (
          <Badge variant="outline">
            {t(($) => $.txSummaryProfit)}:{' '}
            <span className={profitTotal < 0 ? 'text-red-500' : 'text-green-500'}>{format(profitTotal)}</span>
          </Badge>
        ) : null}
        <Badge variant="outline">
          {t(($) => $.txSummaryFees)}: {format(fees)}
        </Badge>
        <Badge
          className={hasFilters ? 'cursor-pointer' : 'cursor-pointer opacity-60'}
          onClick={resetFilters}
          variant={hasFilters ? 'default' : 'outline'}
        >
          {t(($) => $.txSummaryTotal)}: {format(grandTotal)}
        </Badge>
      </div>

      {/* Cross-filters */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs">
        {yearOptions.length > 1 ? (
          <span className="inline-flex flex-wrap items-center gap-1">
            <span className="text-muted-foreground">{t(($) => $.txFilterYear)}:</span>
            {yearOptions.map((year) => (
              <Badge
                className="cursor-pointer"
                key={year}
                onClick={() => toggle(years, year, setYears)}
                variant={years.has(year) ? 'default' : 'outline'}
              >
                {year}
              </Badge>
            ))}
          </span>
        ) : null}
        {magOptions.length > 1 ? (
          <span className="inline-flex flex-wrap items-center gap-1">
            <span className="text-muted-foreground">{t(($) => $.txFilterMagnitude)}:</span>
            {magOptions.map((mag) => (
              <Badge
                className="cursor-pointer"
                key={mag}
                onClick={() => toggle(mags, mag, setMags)}
                variant={mags.has(mag) ? 'default' : 'outline'}
              >
                {formatNumber(10 ** mag, { maximumFractionDigits: 0 })}–
                {formatNumber(10 ** (mag + 1), { maximumFractionDigits: 0 })} €
              </Badge>
            ))}
          </span>
        ) : null}
        {tokenOptions.length > 1 ? (
          <span className="inline-flex flex-wrap items-center gap-1">
            <span className="text-muted-foreground">{t(($) => $.txFilterToken)}:</span>
            {tokenOptions.map((token) => (
              <Badge
                className="cursor-pointer"
                key={token}
                onClick={() => toggle(tokenFilter, token, setTokenFilter)}
                variant={tokenFilter.has(token) ? 'default' : 'outline'}
              >
                {token}
              </Badge>
            ))}
          </span>
        ) : null}
        {hasFilters ? (
          <Button onClick={resetFilters} size="sm" variant="ghost">
            {t(($) => $.txFilterReset)}
          </Button>
        ) : null}
      </div>

      <div className="max-h-96 overflow-y-auto">
        <Table>
          <TableHeader className="sticky top-0 bg-background">
            <TableRow>
              <TableHead className="cursor-pointer select-none" onClick={() => onSort('date')}>
                {t(($) => $.columnDate)}
                {sortIcon('date')}
              </TableHead>
              <TableHead className="cursor-pointer select-none" onClick={() => onSort('type')}>
                {t(($) => $.columnType)}
                {sortIcon('type')}
              </TableHead>
              <TableHead className="cursor-pointer select-none text-right" onClick={() => onSort('token')}>
                {t(($) => $.columnToken)}
                {sortIcon('token')}
              </TableHead>
              <TableHead className="cursor-pointer select-none text-right" onClick={() => onSort('movement')}>
                {t(($) => $.columnValue)}
                {sortIcon('movement')}
              </TableHead>
              <TableHead className="cursor-pointer select-none text-right" onClick={() => onSort('profit')}>
                {t(($) => $.columnProfit)}
                {sortIcon('profit')}
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {visible.map((row) => (
              <TxExplorerRow
                expanded={expanded === row.id}
                format={format}
                key={row.id}
                onToggle={() => setExpanded(expanded === row.id ? null : row.id)}
                row={row}
              />
            ))}
            {visible.length === 0 ? (
              <TableRow>
                <TableCell className="text-center text-muted-foreground" colSpan={5}>
                  {t(($) => $.transactionsEmpty)}
                </TableCell>
              </TableRow>
            ) : null}
          </TableBody>
        </Table>
      </div>
    </div>
  )
}

interface ExplorerRow {
  cost: number
  date: string
  group: FimsTxGroup
  id: number
  movement: number
  profit: number
  signature: null | string
  tokens: string[]
  type: ReturnType<typeof getFimsTransactionType>
}

const signedUnits = (tx: FimsTransaction): string =>
  tx.amount == null ? '—' : `${formatNumber(Number(tx.amount), { maximumFractionDigits: 6 })} ${tx.token ?? ''}`

const rateOf = (tx: FimsTransaction, format: (v: number) => string): string | null =>
  tx.amount != null && Number(tx.amount) !== 0
    ? `1 ${tx.token ?? ''} = ${format(Math.abs(tx.movement) / Math.abs(Number(tx.amount)))}`
    : null

function TxExplorerRow({
  expanded,
  format,
  onToggle,
  row,
}: {
  expanded: boolean
  format: (value: number) => string
  onToggle: () => void
  row: ExplorerRow
}) {
  return (
    <>
      <TableRow className="cursor-pointer" onClick={onToggle}>
        <TableCell className="whitespace-nowrap">{formatDate(row.date)}</TableCell>
        <TableCell>
          <FimsTxTypeLabel transaction={row.group.legs[0]} />
        </TableCell>
        <TableCell className="text-right text-xs">
          {row.group.legs.map((leg) => (
            <div className="whitespace-nowrap" key={leg.id}>
              {signedUnits(leg)}
            </div>
          ))}
        </TableCell>
        <TableCell className="text-right">
          <span className={row.movement < 0 ? 'text-red-500' : 'text-green-500'}>{format(row.movement)}</span>
          {row.cost !== 0 ? <div className="text-muted-foreground text-xs">{format(row.cost)}</div> : null}
        </TableCell>
        <TableCell className={`text-right text-xs ${row.profit < 0 ? 'text-red-500' : 'text-green-500'}`}>
          {row.profit !== 0 ? format(row.profit) : '—'}
        </TableCell>
      </TableRow>
      {expanded ? (
        <TableRow className="bg-muted/30">
          <TableCell className="text-muted-foreground text-xs" colSpan={5}>
            <div className="space-y-1">
              {row.group.legs.map((leg) => {
                const rate = rateOf(leg, format)
                return rate ? <div key={leg.id}>{rate}</div> : null
              })}
              {row.group.legs[0].donationTarget ? (
                <div>
                  → {row.group.legs[0].donationTarget}
                  {row.group.legs[0].donationAmount != null
                    ? ` (${formatNumber(Number(row.group.legs[0].donationAmount))} ${row.group.legs[0].token ?? ''})`
                    : ''}
                </div>
              ) : null}
              {row.signature ? (
                <div>
                  <ExplorerUiTxExternalLink className="underline" signature={row.signature}>
                    {row.signature.slice(0, 12)}…
                  </ExplorerUiTxExternalLink>
                </div>
              ) : null}
            </div>
          </TableCell>
        </TableRow>
      ) : null}
    </>
  )
}
