// Keeps the `prices` history (community perf / real-rate / charts) in sync
// with the Google Sheet "Price" tab — the only source that is updated daily.
// Display-only data: token valuations used by conversions (`tokens.value`)
// are deliberately NOT written here.
import { max, sql } from 'drizzle-orm'
import { prices } from './db/schema.js'
import type { Db } from './db/service.js'

const SHEET_REFERER = 'https://www.fims.fi'
// The sheet appends one row a day; a sync twice a day is plenty and keeps
// the keeper tick (every minute) from hammering the Sheets API.
const MIN_SYNC_INTERVAL_MS = 12 * 60 * 60 * 1000
// Re-read a small overlap so a late correction of yesterday's cell lands.
const OVERLAP_MS = 2 * 24 * 60 * 60 * 1000
// A failing Sheets call must not be retried on every keeper tick: the
// DB-based throttle above only advances on success.
const RETRY_AFTER_FAILURE_MS = 60 * 60 * 1000
let lastAttemptAt = 0

export interface PriceRow {
  date: Date
  price: number
  token: string
}

const num = (v: unknown): null | number => (v === '' || v == null || Number.isNaN(Number(v)) ? null : Number(v))
const str = (v: unknown): string => String(v ?? '').trim()

// Sheets serial date (days since 1899-12-30) or ISO string → Date.
export function sheetDate(v: unknown): Date | null {
  if (v == null || v === '') return null
  if (typeof v === 'number') return new Date(Math.round((v - 25569) * 86400 * 1000))
  const d = new Date(str(v))
  return Number.isNaN(d.getTime()) ? null : d
}

// "Price" tab: a "Date" header row naming each series ("Label (SYMBOL)"),
// then one row per date. Rows on/before `after` are skipped.
export function parsePriceSheet(rows: unknown[][], after: Date | null = null): PriceRow[] {
  const headerIdx = rows.findIndex((r) => str(r[0]) === 'Date')
  const header = rows[headerIdx]
  if (headerIdx < 0 || !header) return []
  const series = header.slice(1).map(str)
  const out: PriceRow[] = []
  for (const row of rows.slice(headerIdx + 1)) {
    const date = sheetDate(row[0])
    if (!date || (after && date <= after)) continue
    row.slice(1).forEach((cell, i) => {
      const price = num(cell)
      const token = series[i]
      if (token && price != null && price > 0) out.push({ date, price, token })
    })
  }
  return out
}

async function fetchPriceSheet(): Promise<unknown[][]> {
  const id = process.env['GOOGLE_SPREADSHEET_ID']
  const key = process.env['GOOGLE_API_KEY']
  if (!id || !key) throw new Error('GOOGLE_SPREADSHEET_ID / GOOGLE_API_KEY not configured')
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${id}/values/${encodeURIComponent('Price!A:ZZ')}?valueRenderOption=UNFORMATTED_VALUE&key=${key}`
  const res = await fetch(url, { headers: { Referer: SHEET_REFERER } })
  if (!res.ok) throw new Error(`Sheets API HTTP ${res.status}`)
  const data = (await res.json()) as { values?: unknown[][] }
  return data.values ?? []
}

export async function syncPrices(
  db: Db,
  now = new Date(),
  fetchSheet: () => Promise<unknown[][]> = fetchPriceSheet,
): Promise<{ inserted: number; skipped?: string }> {
  const [row] = await db.select({ latest: max(prices.date) }).from(prices)
  const latest = row?.latest ?? null
  if (latest && now.getTime() - latest.getTime() < MIN_SYNC_INTERVAL_MS) return { inserted: 0, skipped: 'fresh' }
  if (now.getTime() - lastAttemptAt < RETRY_AFTER_FAILURE_MS) return { inserted: 0, skipped: 'backoff' }
  lastAttemptAt = now.getTime()
  const after = latest ? new Date(latest.getTime() - OVERLAP_MS) : null
  const rows = parsePriceSheet(await fetchSheet(), after)
  for (let i = 0; i < rows.length; i += 500) {
    await db
      .insert(prices)
      .values(rows.slice(i, i + 500))
      .onConflictDoUpdate({ set: { price: sql`excluded.price` }, target: [prices.token, prices.date] })
  }
  return { inserted: rows.length }
}
