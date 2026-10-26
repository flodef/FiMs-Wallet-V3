// Personal treasury reconciliation for the shared account 58kZBjj…
// (= FIMS_TREASURY = the admin's own wallet). Run:
//   cd apps/api && bun --env-file=.env scripts/treasury-reconcile.ts
//
// Two independent reports:
//   1. Personal jlEURC takes: on-chain deltas < 30 jlEURC out of the
//      shared account's jlEURC ATA (larger outflows are user withdrawals).
//   2. Outstanding transfer fees: getFimsFeeRate() of every outflow ledger
//      row dated >= FEE_START, EXCLUDING tontine/donation/deposit/cex_in —
//      the fee is carved in-kind to the treasury (= this same wallet).
//      Note the fee was introduced 2026-10-04 (11e7ba2) but charged in SOL
//      until 2026-10-08 (4d53d82) switched it to the in-kind carve — for
//      Oct 4–8 rows the units column is a notional equivalent, the EUR
//      column is the actual amount owed.
//
// Both are needed to net out who owes what between the shared pot and
// the admin's personal balance.
import { neon } from '@neondatabase/serverless'

import { getFimsFeeRate } from '../src/fee-config.js'

// RPC resolution: configured endpoint → Helius (key already in .env) →
// public endpoint (aggressively rate-limited — last resort only).
// HELIUS_API_KEY is a comma-separated list (see src/helius.ts) — use the
// first key, the joined string is not a valid key.
const heliusKey = process.env['HELIUS_API_KEY']?.split(',')[0]?.trim()
const RPC_URL =
  process.env['SOLANA_RPC_URL'] ??
  (heliusKey ? `https://mainnet.helius-rpc.com/?api-key=${heliusKey}` : null) ??
  'https://api.mainnet-beta.solana.com'
const jlEurcMint = 'GcV9tEj62VncGithz4o4N9x6HWXARxuRgEAYk9zahNA8'
const jlEurcAta = 'ERW9X2uJYrUsXi2prNmBxruVQFDgeetNYv5MUb5ycjyA' // ATA(treasury, SPL Token, jlEURC)
const SMALL_TAKE_MAX = 30 // jlEURC — above this, an outflow is a user withdrawal
const FEE_START = '2026-10-04' // the operating fee was introduced on this date
const MAX_PAGES = 10
const MAX_RETRIES = 4

interface SignatureInfo {
  signature: string
}

interface TokenBalance {
  accountIndex: number
  mint: string
  uiTokenAmount: { uiAmount: null | number }
}

interface ParsedTx {
  blockTime: null | number
  meta: null | {
    err: unknown
    postTokenBalances?: TokenBalance[]
    preTokenBalances?: TokenBalance[]
  }
  transaction: { message: { accountKeys: ({ pubkey: string } | string)[] } }
}

async function rpc<T>(method: string, params: unknown[]): Promise<T> {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const res = await fetch(RPC_URL, {
      body: JSON.stringify({ id: 1, jsonrpc: '2.0', method, params }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    }).catch((e: unknown) => ({ ok: false, status: 0, statusText: String(e) }) as never)
    if (!res.ok) {
      // Rate-limit / transient / transport (status 0): back off and retry;
      // other HTTP errors are fatal.
      if ((res.status === 0 || res.status === 429 || res.status >= 500) && attempt < MAX_RETRIES) {
        await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** attempt))
        continue
      }
      throw new Error(`RPC HTTP ${res.status} on ${method}${res.status === 0 ? `: ${res.statusText}` : ''}`)
    }
    const json = (await res.json()) as { error?: { message: string }; result?: T }
    if (json.error) throw new Error(`RPC error on ${method}: ${json.error.message}`)
    if (json.result === undefined || json.result === null) throw new Error(`RPC ${method}: null result`)
    return json.result
  }
  throw new Error(`RPC ${method}: exhausted ${MAX_RETRIES} retries`)
}

async function jlEurcTakes() {
  let all: SignatureInfo[] = []
  let before: string | undefined
  for (let page = 0; page < MAX_PAGES; page++) {
    const batch = await rpc<SignatureInfo[]>('getSignaturesForAddress', [
      jlEurcAta,
      { limit: 1000, ...(before ? { before } : {}) },
    ])
    if (!batch.length) break
    all = all.concat(batch)
    before = batch.at(-1)?.signature
    if (batch.length < 1000) break
    if (page === MAX_PAGES - 1) {
      console.warn(`WARNING: hit ${MAX_PAGES} pages (${all.length} signatures) — history may be truncated`)
    }
  }
  const takes: { amt: number; date: string; sig: string; ts: number }[] = []
  const skipped: string[] = []
  for (const s of all) {
    let t: ParsedTx
    try {
      t = await rpc<ParsedTx>('getTransaction', [
        s.signature,
        { encoding: 'jsonParsed', maxSupportedTransactionVersion: 1 },
      ])
    } catch {
      // Pruned/unavailable tx: collected and reported below, not silently dropped.
      skipped.push(s.signature)
      continue
    }
    if (!t.meta || t.meta.err != null || !t.blockTime) continue
    const keys = t.transaction.message.accountKeys.map((k) => (typeof k === 'string' ? k : k.pubkey))
    const idx = keys.indexOf(jlEurcAta)
    if (idx < 0) continue
    const bal = (b: TokenBalance) => b.accountIndex === idx && b.mint === jlEurcMint
    const pre = (t.meta.preTokenBalances ?? []).find(bal)
    const post = (t.meta.postTokenBalances ?? []).find(bal)
    // uiAmount is null for an exact drain/close — flag instead of
    // silently treating it as zero.
    if (post?.uiTokenAmount.uiAmount == null && pre?.uiTokenAmount.uiAmount == null) continue
    if (post?.uiTokenAmount.uiAmount == null || pre?.uiTokenAmount.uiAmount == null) {
      console.warn(`WARNING: null uiAmount on ${s.signature} — ATA drain/close, check manually`)
      continue
    }
    const delta = post.uiTokenAmount.uiAmount - pre.uiTokenAmount.uiAmount
    if (delta < 0 && delta > -SMALL_TAKE_MAX) {
      takes.push({
        amt: -delta,
        date: new Date(t.blockTime * 1000).toISOString().slice(0, 10),
        sig: s.signature,
        ts: t.blockTime,
      })
    }
  }
  takes.sort((a, b) => a.ts - b.ts)
  console.log(`\n== jlEURC personal takes (< ${SMALL_TAKE_MAX}) ==`)
  for (const t of takes) console.log(`${t.date}  ${t.amt.toFixed(4)} jlEURC  ${t.sig}`)
  console.log(`TOTAL: ${takes.reduce((a, t) => a + t.amt, 0).toFixed(4)} jlEURC`)
  if (skipped.length) {
    console.warn(`WARNING: ${skipped.length} transactions could not be fetched — total may be understated:`)
    for (const s of skipped) console.warn(`  ${s}`)
  }
}

async function transferFees() {
  const dbUrl = process.env['DATABASE_URL']
  if (!dbUrl) throw new Error('DATABASE_URL required')
  const sql = neon(dbUrl)
  // donation_amount is ON TOP of amount (schema.ts) — the ledger row's
  // |amount| is already the post-carve outflow, so it is the feeable base
  // exactly. payment rows carry movement ~= cost (both negative), so
  // |movement + cost| ~= 2x value there — use |movement| as their EUR base.
  // Zero-valued rows (movement=0/cost=0) carried no feeable value.
  // Units on `conversion` rows are denominated in the DEBITED token here;
  // the carved fee is actually credited-token units (convert.ts), so treat
  // that column as approximate for conversions — the EUR column is exact.
  // Caveat: assumes every listed outflow carried the fee — carve-exempt
  // flows (Solana Pay, trigger/limit orders) still write outflow rows.
  const rows = await sql`
    SELECT token, type, COUNT(*) n,
      SUM(ABS(amount) * ${getFimsFeeRate()}) AS fee_units,
      SUM(
        CASE WHEN type = 'payment' THEN ABS(movement) ELSE ABS(movement + cost) END * ${getFimsFeeRate()}
      ) AS fee_eur
    FROM transactions
    WHERE amount < 0 AND date >= ${FEE_START}
      AND (movement <> 0 OR cost <> 0)
      AND type IN ('withdrawal', 'payment', 'conversion', 'cex_out')
    GROUP BY token, type ORDER BY token, type`
  console.log(
    `\n== transfer fees (${getFimsFeeRate() * 100}% of outflows since ${FEE_START}, excl. tontine/donation) ==`,
  )
  let eur = 0
  for (const r of rows) {
    console.log(
      `${r['token']} ${r['type']}  x${r['n']}  ${Number(r['fee_units']).toFixed(4)} units  ${Number(r['fee_eur']).toFixed(2)} EUR`,
    )
    eur += Number(r['fee_eur'])
  }
  console.log(`TOTAL: ${eur.toFixed(2)} EUR`)
}

await jlEurcTakes()
await transferFees()
