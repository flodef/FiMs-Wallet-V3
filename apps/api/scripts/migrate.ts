/**
 * One-shot ETL: Google Sheets + Vercel Postgres + Firebase → Neon (V3 schema).
 *
 * Usage:
 *   bun --env-file=.env scripts/migrate.ts [--dry-run]
 *
 * Required env (see .env.example):
 *   DATABASE_URL           target Neon database
 *   POSTGRES_URL           legacy Vercel Postgres
 *   GOOGLE_API_KEY / GOOGLE_SPREADSHEET_ID
 *   FIREBASE_API_KEY / FIREBASE_PROJECT_ID / FIREBASE_APP_ID
 */
// cspell:ignore firebaseapp appspot
import { neon } from '@neondatabase/serverless'
import { sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/neon-http'
import { getApp, getApps, initializeApp } from 'firebase/app'
import { collection, getDocs, getFirestore } from 'firebase/firestore'
import postgres from 'postgres'
import * as s from '../src/db/schema.js'

const DRY_RUN = process.argv.includes('--dry-run')

const env = (name: string) => {
  const v = process.env[name]
  if (!v) throw new Error(`Missing env var: ${name}`)
  return v
}

// ---------------------------------------------------------------------------
// Google Sheets
// ---------------------------------------------------------------------------

const SHEET_RANGES = {
  dashboard: { range: 'A:C' },
  historic: { range: 'A:D' },
  portfolio: { range: 'A:O' },
  price: { range: 'A1:R368' },
  tokens: { range: 'A:J' },
  transactions: { range: 'A:H' },
} as const

// Per-user history lives in a tab named after the legacy user id
const USER_HISTORIC_RANGE = 'A:I'

async function fetchSheet(tab: string, range: string): Promise<(string | number)[][] | null> {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${env('GOOGLE_SPREADSHEET_ID')}/values/${encodeURIComponent(
    `${tab}!${range}`,
  )}?valueRenderOption=UNFORMATTED_VALUE&key=${env('GOOGLE_API_KEY')}`
  const res = await fetch(url, { headers: { Referer: 'https://www.fims.fi' } })
  if (!res.ok) return null
  const data = (await res.json()) as { values?: (string | number)[][] }
  return data.values ?? []
}

const serialDate = (n: number) => new Date(Math.round((n - 25569) * 86400 * 1000))
const num = (v: unknown): number | null => (v === '' || v == null || Number.isNaN(Number(v)) ? null : Number(v))
const str = (v: unknown): string => String(v ?? '').trim()

// ---------------------------------------------------------------------------
// Load static sources
// ---------------------------------------------------------------------------

type SheetKey = keyof typeof SHEET_RANGES
const sheets = {} as Record<SheetKey, (string | number)[][]>
for (const [key, cfg] of Object.entries(SHEET_RANGES) as [SheetKey, { range: string }][]) {
  const tab = key === 'price' ? 'Price' : key.charAt(0).toUpperCase() + key.slice(1)
  sheets[key] = (await fetchSheet(tab, cfg.range)) ?? []
  console.log(`sheet ${key}: ${sheets[key].length} rows`)
}

const pg = postgres(env('POSTGRES_URL'), { max: 1, ssl: 'require' })
const pgUsers = (await pg`SELECT * FROM users`) as {
  id: number
  name: string
  address: string
  ispublic: boolean
}[]
const pgTransactions = (await pg`SELECT * FROM transactions`) as {
  id: number
  date: string
  address: string
  movement: number
  cost: number
  userid: number | null
  token: string | null
  amount: number | null
  type: string | null
}[]
await pg.end()
console.log(`vercel pg: ${pgUsers.length} users, ${pgTransactions.length} transactions`)

const fbApp = getApps().length
  ? getApp()
  : initializeApp({
      apiKey: env('FIREBASE_API_KEY'),
      appId: env('FIREBASE_APP_ID'),
      authDomain: `${env('FIREBASE_PROJECT_ID')}.firebaseapp.com`,
      projectId: env('FIREBASE_PROJECT_ID'),
      storageBucket: `${env('FIREBASE_PROJECT_ID')}.appspot.com`,
    })
const fb = getFirestore(fbApp)
const fbUsers = (await getDocs(collection(fb, 'users'))).docs.map((d) => d.data()) as {
  id: number
  name: string
  address: string
  isPublic: boolean
  isPro?: boolean
}[]
const fbTransactions = (await getDocs(collection(fb, 'transactions'))).docs.map((d) => d.data()) as {
  id: number
  date: string | number | { toDate?: () => Date }
  userId: number | null
  address: string
  movement: number
  cost: number
  token: string | null
  amount: number | null
}[]
console.log(`firebase: ${fbUsers.length} users, ${fbTransactions.length} transactions`)

// ---------------------------------------------------------------------------
// Merge users — canonical key = lowercase name
// ---------------------------------------------------------------------------

type MergedUser = { name: string; address: string; isPublic: boolean; isPro: boolean; legacyIds: number[] }
const usersByName = new Map<string, MergedUser>()
const legacyIdToKey = new Map<number, string>()

const mergeUser = (u: {
  id?: number | undefined
  name?: unknown
  address?: unknown
  isPublic?: boolean | undefined
  isPro?: boolean | undefined
}) => {
  const name = str(u.name)
  if (!name) return
  const key = name.toLowerCase()
  const existing = usersByName.get(key)
  if (existing) {
    existing.address = str(u.address) || existing.address
    existing.isPublic = u.isPublic ?? existing.isPublic
    existing.isPro = u.isPro ?? existing.isPro
    if (u.id != null && !existing.legacyIds.includes(u.id)) existing.legacyIds.push(u.id)
  } else {
    usersByName.set(key, {
      address: str(u.address),
      isPro: u.isPro ?? false,
      isPublic: u.isPublic ?? true,
      legacyIds: u.id != null ? [u.id] : [],
      name,
    })
  }
  if (u.id != null) legacyIdToKey.set(u.id, key)
}

for (const u of pgUsers) mergeUser({ address: u.address, id: u.id, isPublic: u.ispublic, name: u.name })
for (const u of fbUsers) mergeUser({ address: u.address, id: u.id, isPro: u.isPro, isPublic: u.isPublic, name: u.name })
for (const row of sheets.portfolio.slice(1)) {
  mergeUser({ address: row[2], id: num(row[0]) ?? undefined, isPublic: row[3] === 'true', name: row[1] })
}
console.log(`merged users: ${usersByName.size}`)

// ---------------------------------------------------------------------------
// Per-user historic — one sheet tab per legacy user id
// ---------------------------------------------------------------------------

type UserHistoricRow = { userKey: string; date: Date; invested: number; total: number | null }
const userHistoricRows: UserHistoricRow[] = []
for (const [key, u] of usersByName) {
  for (const legacyId of u.legacyIds) {
    const rows = await fetchSheet(String(legacyId), USER_HISTORIC_RANGE)
    if (!rows) continue
    let count = 0
    for (const row of rows.slice(1)) {
      const d = toDate(row[0])
      const invested = num(row[2])
      if (d && invested != null) {
        userHistoricRows.push({ date: d, invested, total: num(row[8]), userKey: key })
        count++
      }
    }
    if (count) console.log(`user historic: ${u.name} (tab ${legacyId}) → ${count} rows`)
    break // first matching tab wins
  }
}

// ---------------------------------------------------------------------------
// Transactions — dedupe across the 3 sources
// ---------------------------------------------------------------------------

function toDate(v: unknown): Date | null {
  if (v == null || v === '') return null
  if (v instanceof Date) return v
  if (typeof v === 'object' && 'toDate' in v && typeof (v as { toDate?: unknown }).toDate === 'function')
    return (v as { toDate: () => Date }).toDate()
  if (typeof v === 'number') return serialDate(v)
  const d = new Date(str(v))
  return Number.isNaN(d.getTime()) ? null : d
}

type TxInput = {
  date: unknown
  legacyUserId?: number | null
  address?: unknown
  movement?: unknown
  cost?: unknown
  token?: unknown
  amount?: unknown
  type?: string | null
}
const txSeen = new Set<string>()
// V2 rule: |movement - cost| ≈ 0 means the row is a donation (in) or payment (out),
// otherwise a deposit/withdrawal. Explicit types (tontine, cex_*) are kept as stored.
const deriveTxType = (movement: number, cost: number) => {
  const special = Math.abs(movement - cost) < 0.01
  return movement > 0 ? (special ? 'donation' : 'deposit') : special ? 'payment' : 'withdrawal'
}

const txRows: { userKey: string | null; row: typeof s.transactions.$inferInsert }[] = []

const pushTx = (t: TxInput) => {
  const date = toDate(t.date)
  const address = str(t.address)
  if (!date || !address) return
  const userKey = t.legacyUserId != null ? (legacyIdToKey.get(t.legacyUserId) ?? null) : null
  const dedupe = [
    date.toISOString().slice(0, 10),
    userKey ?? '',
    address,
    num(t.movement) ?? '',
    str(t.token),
    num(t.amount) ?? '',
  ].join('|')
  if (txSeen.has(dedupe)) return
  txSeen.add(dedupe)
  txRows.push({
    row: {
      address,
      amount: num(t.amount),
      cost: num(t.cost) ?? 0,
      date,
      movement: num(t.movement) ?? 0,
      token: str(t.token) || null,
      type:
        (t.type as (typeof s.transactions.$inferInsert)['type']) ??
        deriveTxType(num(t.movement) ?? 0, num(t.cost) ?? 0),
    },
    userKey,
  })
}

for (const t of pgTransactions) {
  pushTx({
    address: t.address,
    amount: t.amount,
    cost: t.cost,
    date: t.date,
    legacyUserId: t.userid,
    movement: t.movement,
    token: t.token,
    type: t.type,
  })
}
for (const t of fbTransactions) {
  pushTx({
    address: t.address,
    amount: t.amount,
    cost: t.cost,
    date: t.date,
    legacyUserId: t.userId,
    movement: t.movement,
    token: t.token,
  })
}
for (const row of sheets.transactions.slice(1)) {
  pushTx({
    address: row[3],
    amount: row[7],
    cost: row[5],
    date: row[1],
    legacyUserId: num(row[2]),
    movement: row[4],
    token: row[6],
  })
}
console.log(`merged transactions: ${txRows.length}`)

// ---------------------------------------------------------------------------
// Sheets-only tables
// ---------------------------------------------------------------------------

const tokenRows = sheets.tokens.slice(1).flatMap((row) =>
  str(row[0])
    ? [
        {
          address: str(row[2]) || null,
          description: str(row[9]) || null,
          duration: num(row[7]),
          inceptionPrice: num(row[6]),
          inceptionRatio: num(row[5]),
          label: str(row[1]) || str(row[0]),
          symbol: str(row[0]),
          value: num(row[3]),
          volatility: num(row[8]),
          yearlyYield: num(row[4]),
        },
      ]
    : [],
)

const metricRows = sheets.dashboard
  .slice(1)
  .flatMap((row) => (str(row[0]) ? [{ label: str(row[0]), ratio: num(row[2]), value: num(row[1]) ?? 0 }] : []))

const historicRows = sheets.historic.slice(1).flatMap((row) => {
  const date = toDate(row[0])
  return date ? [{ date, invested: num(row[1]) ?? 0, treasury: num(row[3]) }] : []
})

const priceRows: (typeof s.prices.$inferInsert)[] = []
{
  const rows = sheets.price
  const headerIdx = rows.findIndex((r) => str(r[0]) === 'Date')
  const headerRow = rows[headerIdx]
  if (headerIdx >= 0 && headerRow) {
    const symbols = headerRow.slice(1).map(str)
    for (const row of rows.slice(headerIdx + 1)) {
      const date = toDate(row[0])
      if (!date) continue
      row.slice(1).forEach((cell, i) => {
        const price = num(cell)
        const token = symbols[i]
        if (token && price != null) priceRows.push({ date, price, token })
      })
    }
  }
}
console.log(
  `sheets: ${tokenRows.length} tokens, ${metricRows.length} metrics, ${historicRows.length} historic, ${userHistoricRows.length} user-historic, ${priceRows.length} prices`,
)

// ---------------------------------------------------------------------------
// Write to Neon
// ---------------------------------------------------------------------------

if (DRY_RUN) {
  console.log('\n[dry-run] sample user:', [...usersByName.values()][0])
  console.log('[dry-run] sample tx:', txRows[0])
  console.log('[dry-run] done — nothing written.')
  process.exit(0)
}

const db = drizzle(neon(env('DATABASE_URL')), { schema: s })

const keyToNewId = new Map<string, number>()
for (const u of usersByName.values()) {
  const [row] = await db
    .insert(s.users)
    .values({ address: u.address, isPro: u.isPro, isPublic: u.isPublic, name: u.name })
    .onConflictDoUpdate({
      set: {
        address: sql`excluded.address`,
        isPro: sql`excluded.is_pro`,
        isPublic: sql`excluded.is_public`,
        updatedAt: new Date(),
      },
      target: s.users.name,
    })
    .returning({ id: s.users.id })
  if (row) keyToNewId.set(u.name.toLowerCase(), row.id)
}
console.log(`users written: ${keyToNewId.size}`)

const CHUNK = 200
const batch = async <T>(rows: T[], fn: (chunk: T[]) => Promise<unknown>, label: string, key?: (row: T) => string) => {
  // ON CONFLICT cannot touch the same key twice in one statement: dedupe first (last wins)
  const deduped = key ? [...new Map(rows.map((r) => [key(r), r])).values()] : rows
  const dupes = rows.length - deduped.length
  if (dupes > 0) console.log(`${label}: skipped ${dupes} duplicate key(s)`)
  if (!deduped.length) return
  for (let i = 0; i < deduped.length; i += CHUNK) await fn(deduped.slice(i, i + CHUNK))
  console.log(`${label} written: ${deduped.length}`)
}

await batch(
  txRows,
  (chunk) =>
    db
      .insert(s.transactions)
      .values(
        chunk.map(({ userKey, row }) => ({ ...row, userId: userKey ? (keyToNewId.get(userKey) ?? null) : null })),
      ),
  'transactions',
)

await batch(
  userHistoricRows,
  (chunk) =>
    db
      .insert(s.userHistoric)
      .values(
        chunk.flatMap(({ userKey, date, invested, total }) => {
          const userId = keyToNewId.get(userKey)
          return userId ? [{ date, invested, total, userId }] : []
        }),
      )
      .onConflictDoUpdate({
        set: { invested: sql`excluded.invested`, total: sql`excluded.total` },
        target: [s.userHistoric.userId, s.userHistoric.date],
      }),
  'user_historic',
  (r) => `${r.userKey}|${r.date}`,
)

await batch(
  tokenRows,
  (chunk) =>
    db
      .insert(s.tokens)
      .values(chunk)
      .onConflictDoUpdate({
        set: {
          address: sql`excluded.address`,
          description: sql`excluded.description`,
          duration: sql`excluded.duration`,
          inceptionPrice: sql`excluded.inception_price`,
          inceptionRatio: sql`excluded.inception_ratio`,
          label: sql`excluded.label`,
          updatedAt: new Date(),
          value: sql`excluded.value`,
          volatility: sql`excluded.volatility`,
          yearlyYield: sql`excluded.yearly_yield`,
        },
        target: s.tokens.symbol,
      }),
  'tokens',
  (r) => r.symbol,
)

await batch(
  metricRows,
  (chunk) =>
    db
      .insert(s.dashboardMetrics)
      .values(chunk)
      .onConflictDoUpdate({
        set: { ratio: sql`excluded.ratio`, value: sql`excluded.value` },
        target: s.dashboardMetrics.label,
      }),
  'dashboard_metrics',
  (r) => r.label,
)

await batch(
  historicRows,
  (chunk) =>
    db
      .insert(s.historic)
      .values(chunk)
      .onConflictDoUpdate({
        set: { invested: sql`excluded.invested`, treasury: sql`excluded.treasury` },
        target: s.historic.date,
      }),
  'historic',
  (r) => `${r.date}`,
)

await batch(
  priceRows,
  (chunk) =>
    db
      .insert(s.prices)
      .values(chunk)
      .onConflictDoUpdate({
        set: { price: sql`excluded.price` },
        target: [s.prices.token, s.prices.date],
      }),
  'prices',
  (r) => `${r.token}|${r.date}`,
)

console.log('migration done')
process.exit(0)
