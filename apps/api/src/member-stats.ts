// cspell:ignore cumul AVERAGEIF upserts
// Member portfolio summary recomputed from the `transactions` ledger — the
// same formulas the legacy spreadsheet "Portfolio"/member tabs applied, so
// the wallet no longer needs the sheet (or the stale `user_historic` ETL
// snapshot) to display a member's position.
//
// Spreadsheet equivalences (verified against production rows):
//   invested       = Σ movement − Σ|cost|        — every fee eats capital,
//                    donation rows (movement = cost > 0) net to zero
//   grossDeposits  = Σ movement where movement > 0 — the profit-ratio
//                    denominator (gross inflows, not net invested)
//   donated        = Σ movement where cost > 0 (pure gift rows) + the EUR
//                    share of embedded gifts (donation_amount on outflows)
//   units(token)   = Σ amount − Σ donation_amount over rows where
//                    type <> 'donation' — the donation row's +amount belongs
//                    to the tontine side, the paired withdrawal carries the
//                    member's outflow
//   total          = Σ units × latest price over the protocol tokens
//   profit         = total − invested (0 when the position is flat)
//   yearlyRate     = (profit ÷ mean monthly cumulated invested)
//                    ÷ max(1, years since first transaction) — a simple
//                    annualized rate on average deployed capital
import { and, asc, eq, isNotNull, ne, sql } from 'drizzle-orm'
import { fimsSettings, prices, tokens, transactions, userHistoric } from './db/schema.js'
import type { Db } from './db/service.js'

const DAY_MS = 24 * 60 * 60 * 1000
const DAYS_PER_YEAR = 365.25

// The three protocol positions the spreadsheet aggregated (columns E–G of
// the Portfolio tab): FiMs SOL, FiMs Token and FiMs Liquidity Provider.
export const MEMBER_POSITION_SYMBOLS = ['FSOL', 'FiMs', 'FLiP'] as const

export interface MemberLedgerRow {
  amount: null | string
  cost: number
  date: Date
  donationAmount: null | string
  donationTarget: null | string
  movement: number
  token: null | string
  type: null | string
}

export interface MemberPosition {
  price: null | number
  symbol: string
  units: number
  value: number
}

export interface MemberSummary {
  donated: number
  durationDays: null | number
  grossDeposits: number
  invested: number
  positions: MemberPosition[]
  profit: number
  profitRatio: null | number
  total: number
  yearlyRate: null | number
}

// UTC first-of-month containing `date` — the boundaries the spreadsheet
// member tabs used for their monthly rows.
export function monthStart(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1))
}

// Net EUR invested contribution of a row: movement minus the absolute fee.
export const netInvested = (row: Pick<MemberLedgerRow, 'cost' | 'movement'>) => row.movement - Math.abs(row.cost)

// EUR value of an embedded gift (donation_amount on an outflow row), priced
// at the row's implied gross rate |movement + cost| / |amount|.
const embeddedGift = (row: MemberLedgerRow): number => {
  const amount = Number(row.amount)
  const donation = Number(row.donationAmount)
  if (!row.donationTarget || !amount || !donation || donation <= 0) return 0
  return (Math.abs(row.movement + row.cost) * donation) / Math.abs(amount)
}

// Pure summary over one member's ledger — separated from the DB reads so
// the formulas are unit-testable without a database.
export function summarizeMember(
  rows: MemberLedgerRow[],
  priceBySymbol: ReadonlyMap<string, number>,
  now = new Date(),
): MemberSummary {
  let invested = 0
  let grossDeposits = 0
  let donated = 0
  const units = new Map<string, number>()
  for (const row of rows) {
    invested += netInvested(row)
    if (row.movement > 0) grossDeposits += row.movement
    if (row.cost > 0) donated += row.movement
    donated += embeddedGift(row)
    if (row.type !== 'donation' && row.token && row.amount != null) {
      units.set(row.token, (units.get(row.token) ?? 0) + Number(row.amount) - Number(row.donationAmount ?? 0))
    }
  }

  const positions = MEMBER_POSITION_SYMBOLS.map((symbol) => {
    const tokenUnits = units.get(symbol) ?? 0
    const price = priceBySymbol.get(symbol) ?? null
    return { price, symbol, units: tokenUnits, value: tokenUnits * (price ?? 0) }
  })
  const total = positions.reduce((sum, position) => sum + position.value, 0)
  const profit = total !== 0 ? total - invested : 0
  const profitRatio = grossDeposits > 0 ? profit / grossDeposits : null

  const firstTx = rows[0]?.date ?? null
  const durationDays = firstTx ? Math.max(0, (now.getTime() - firstTx.getTime()) / DAY_MS) : null

  // Mean monthly cumulated invested (the sheet's AVERAGEIF over its monthly
  // Cumul value column): one point for "now" plus one per month start back
  // to the first transaction's month.
  let yearlyRate: null | number = null
  if (firstTx) {
    const cumulPoints: number[] = [invested]
    const cursor = monthStart(now)
    const end = monthStart(firstTx)
    while (cursor.getTime() >= end.getTime()) {
      let cumul = 0
      for (const row of rows) if (row.date < cursor) cumul += netInvested(row)
      cumulPoints.push(cumul)
      cursor.setUTCMonth(cursor.getUTCMonth() - 1)
    }
    const nonZero = cumulPoints.filter((value) => value !== 0)
    const meanCumul = nonZero.length ? nonZero.reduce((sum, value) => sum + value, 0) / nonZero.length : 0
    const years = Math.max(1, (durationDays ?? 0) / DAYS_PER_YEAR)
    yearlyRate = meanCumul !== 0 ? profit / meanCumul / years : null
  }

  return { donated, durationDays, grossDeposits, invested, positions, profit, profitRatio, total, yearlyRate }
}

// Latest known EUR price per token symbol. `prices` rows are keyed
// "Label (SYMBOL)" and synced twice a day; `tokens.value` is the stale
// fallback for symbols the history never covered.
export async function latestPricesBySymbol(db: Db): Promise<Map<string, number>> {
  const [priceRows, tokenRows] = await Promise.all([
    db.execute(
      sql`SELECT DISTINCT ON (token) token, price::float AS price FROM ${prices} ORDER BY token, ${prices.date} DESC`,
    ),
    db.select({ symbol: tokens.symbol, value: tokens.value }).from(tokens),
  ])
  const bySymbol = new Map<string, number>()
  for (const row of tokenRows) if (row.value !== null) bySymbol.set(row.symbol, row.value)
  for (const row of priceRows.rows as { price: number; token: string }[]) {
    const symbol = /\(([^)]+)\)$/.exec(row.token)?.[1]
    if (symbol) bySymbol.set(symbol, row.price)
  }
  return bySymbol
}

export async function memberSummary(db: Db, userId: number, now = new Date()): Promise<MemberSummary> {
  const [rows, priceBySymbol] = await Promise.all([
    db
      .select({
        amount: transactions.amount,
        cost: transactions.cost,
        date: transactions.date,
        donationAmount: transactions.donationAmount,
        donationTarget: transactions.donationTarget,
        movement: transactions.movement,
        token: transactions.token,
        type: transactions.type,
      })
      .from(transactions)
      .where(eq(transactions.userId, userId))
      .orderBy(asc(transactions.date)),
    latestPricesBySymbol(db),
  ])
  return summarizeMember(rows, priceBySymbol, now)
}

// Per-member monthly history (the `user_historic` chart source): for every
// month start covered by the `prices` window, replay the ledger up to that
// date for invested + units, then price the units at the last known price
// before the boundary. Older rows predate the price history and are left
// untouched. Replaces the external ETL that died early October.
export const USER_HISTORIC_SYNC_KEY = 'user_historic_synced_at'
const USER_HISTORIC_MIN_INTERVAL_MS = 12 * 60 * 60 * 1000

interface SymbolPricePoint {
  date: Date
  price: number
}

const priceAt = (series: SymbolPricePoint[], at: Date): number | null => {
  // Series are asc; scan from the end — snapshots are usually recent.
  for (let i = series.length - 1; i >= 0; i--) {
    const point = series[i]
    if (point && point.date <= at) return point.price
  }
  return series[0]?.price ?? null
}

export async function syncUserHistoric(db: Db, now = new Date()): Promise<{ inserted: number; skipped?: string }> {
  const settings = await db.select().from(fimsSettings).where(eq(fimsSettings.key, USER_HISTORIC_SYNC_KEY))
  const lastSync = settings[0] ? new Date(settings[0].value).getTime() : 0
  if (now.getTime() - lastSync < USER_HISTORIC_MIN_INTERVAL_MS) return { inserted: 0, skipped: 'fresh' }

  const firstPriceRows = await db.execute(sql`SELECT min(${prices.date}) AS first FROM ${prices}`)
  const firstPriceDate = (firstPriceRows.rows[0] as { first: Date | null } | undefined)?.first
  if (!firstPriceDate) return { inserted: 0, skipped: 'no prices' }
  // Only month starts whose price lookup can succeed — prices begin ~Oct
  // 2025, so the earliest boundary we can price is the following month start.
  const earliest = new Date(Date.UTC(firstPriceDate.getUTCFullYear(), firstPriceDate.getUTCMonth() + 1, 1))

  const [priceRows, ledgerRows, memberRows] = await Promise.all([
    db.select({ date: prices.date, price: prices.price, token: prices.token }).from(prices).orderBy(asc(prices.date)),
    db
      .select({
        amount: transactions.amount,
        cost: transactions.cost,
        date: transactions.date,
        donationAmount: transactions.donationAmount,
        movement: transactions.movement,
        token: transactions.token,
        type: transactions.type,
        userId: transactions.userId,
      })
      .from(transactions)
      .orderBy(asc(transactions.date)),
    db.execute(
      sql`SELECT DISTINCT ${transactions.userId} AS user_id FROM ${transactions} WHERE ${and(
        isNotNull(transactions.userId),
        ne(transactions.type, 'donation'),
      )}`,
    ),
  ])

  const seriesBySymbol = new Map<string, SymbolPricePoint[]>()
  for (const row of priceRows) {
    const symbol = /\(([^)]+)\)$/.exec(row.token)?.[1]
    if (!symbol) continue
    const series = seriesBySymbol.get(symbol) ?? []
    series.push({ date: row.date, price: row.price })
    seriesBySymbol.set(symbol, series)
  }

  const byUser = new Map<number, typeof ledgerRows>()
  for (const row of ledgerRows) {
    if (row.userId === null) continue
    const list = byUser.get(row.userId) ?? []
    list.push(row)
    byUser.set(row.userId, list)
  }

  const symbols = [...seriesBySymbol.keys()]
  const upserts: { date: Date; invested: number; total: number; userId: number }[] = []
  for (const { user_id: userId } of memberRows.rows as { user_id: number }[]) {
    const rows = byUser.get(userId) ?? []
    const firstTx = rows[0]?.date
    if (!firstTx) continue
    const start = new Date(Math.max(earliest.getTime(), monthStart(firstTx).getTime()))
    const cursor = monthStart(now)
    while (cursor.getTime() >= start.getTime()) {
      let invested = 0
      const units = new Map<string, number>()
      for (const row of rows) {
        if (row.date >= cursor) continue
        invested += netInvested(row)
        if (row.type !== 'donation' && row.token && row.amount != null) {
          units.set(row.token, (units.get(row.token) ?? 0) + Number(row.amount) - Number(row.donationAmount ?? 0))
        }
      }
      const total = symbols.reduce((sum, symbol) => {
        const tokenUnits = units.get(symbol) ?? 0
        if (tokenUnits === 0) return sum
        const price = priceAt(seriesBySymbol.get(symbol) ?? [], cursor)
        return price === null ? sum : sum + tokenUnits * price
      }, 0)
      upserts.push({ date: new Date(cursor), invested, total, userId })
      cursor.setUTCMonth(cursor.getUTCMonth() - 1)
    }
  }

  for (let i = 0; i < upserts.length; i += 200) {
    await db
      .insert(userHistoric)
      .values(upserts.slice(i, i + 200))
      .onConflictDoUpdate({
        set: { invested: sql`excluded.invested`, total: sql`excluded.total` },
        target: [userHistoric.userId, userHistoric.date],
      })
  }
  await db
    .insert(fimsSettings)
    .values({ key: USER_HISTORIC_SYNC_KEY, value: now.toISOString() })
    .onConflictDoUpdate({ set: { value: sql`excluded.value` }, target: [fimsSettings.key] })
  return { inserted: upserts.length }
}
