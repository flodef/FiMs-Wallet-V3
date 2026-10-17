import { Headers, HttpServerRequest } from '@effect/platform'
import { eq, or, sql } from 'drizzle-orm'
import { Effect, Option } from 'effect'
import { addressBook, tokens, userAddresses, users } from '../../../db/schema.js'
import { DatabaseService, type Db, withDb } from '../../../db/service.js'
import { envInt } from '../../../env.js'
import { FIMS_TONTINE_ADDRESS, FIMS_TREASURY_ADDRESS } from '../../../fims-constants.js'
import {
  chainSymbolForMint,
  fetchHeliusAssets,
  fetchHeliusTransactions,
  heliusApiKeys,
  normalizeGtfaTransaction,
} from '../../../helius.js'
import { AuthForbidden, isAdminAddress, verifyWalletRequest } from '../../../services/auth/service.js'
import { ChainUnavailable, RateLimited } from '../api.js'
import { addressLinkedToUser } from '../helpers.js'

export const handleChainLabels = () =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest
    const signer = yield* verifyWalletRequest(request)
    const { rows } = yield* withDb((db) => loadChainLabels(db, Option.some(signer)))
    return rows.slice(0, CHAIN_ADDRESS_MAX)
  })

export const handleChainHistory = ({
  urlParams,
}: {
  urlParams: { address: string; cursor?: string | undefined; limit?: number | undefined }
}) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest
    const signer = yield* verifyWalletRequest(request)
    yield* consumeChainQuota(request, signer)
    yield* assertChainAddressAllowed(signer, urlParams.address)
    const keys = yield* heliusKeysOrFail
    const limit = Math.min(Math.max(1, Math.floor(urlParams.limit ?? 100)), 100)
    const page = yield* Effect.tryPromise({
      catch: chainUnavailable,
      try: () => fetchHeliusTransactions(keys, urlParams.address, { cursor: urlParams.cursor, limit }),
    })
    const { labels, symbols } = yield* withDb((db) => loadChainLabels(db, Option.some(signer)))
    const flat = new Map([...labels.entries()].map(([a, v]) => [a, v.label] as const))
    return {
      cursor: page.paginationToken ?? null,
      transactions: page.data
        .map((tx) => normalizeGtfaTransaction(tx, urlParams.address, flat, symbols))
        .filter((tx) => tx !== null),
    }
  })

export const handleChainAssets = ({ urlParams }: { urlParams: { address: string } }) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest
    const signer = yield* verifyWalletRequest(request)
    yield* consumeChainQuota(request, signer)
    yield* assertChainAddressAllowed(signer, urlParams.address)
    const keys = yield* heliusKeysOrFail
    const assets = yield* Effect.tryPromise({
      catch: chainUnavailable,
      try: () => fetchHeliusAssets(keys, urlParams.address),
    })
    const { symbols } = yield* withDb((db) => loadChainLabels(db, Option.some(signer)))
    // FiMs-family mints have no Helius price feed — the `tokens` table is the
    // protocol's own source: `value` is EUR per unit, and the USDC row gives
    // the EUR→USD conversion so the chain reader can price the P&L.
    const tokenRows = yield* withDb((db) =>
      db.select({ address: tokens.address, symbol: tokens.symbol, value: tokens.value }).from(tokens),
    )
    const usdcEur = tokenRows.find((row) => row.symbol === 'USDC')?.value ?? null
    const eurToUsd = usdcEur && usdcEur > 0 ? 1 / usdcEur : null
    const fimsUsdByMint = new Map(
      eurToUsd === null
        ? []
        : tokenRows
            .filter((row) => row.address && row.value !== null && row.value > 0)
            .map((row) => [row.address as string, (row.value as number) * eurToUsd]),
    )
    return assets.map((asset) => ({
      ...asset,
      symbol: asset.mint ? (asset.symbol ?? chainSymbolForMint(asset.mint, symbols)) : 'SOL',
      usdPrice: asset.usdPrice ?? (asset.mint ? (fimsUsdByMint.get(asset.mint) ?? null) : null),
    }))
  })

// ─── On-chain tx reader ─────────────────────────────────────────────────────
// Helius calls are proxied here so the API key(s) stay server-side. Labels let
// the UI render "Tontine", "FiMs Treasury", member names or CEX labels instead
// of raw addresses.

const CHAIN_ADDRESS_MAX = 200

interface ChainLabelRow {
  address: string
  kind: 'cex' | 'member' | 'other' | 'tontine' | 'treasury'
  label: string
}

// Every address the reader can name, in precedence order: built-ins first,
// then the caller's OWN address-book entries, then members. Non-public
// members are only named for themselves and admins — a private member's
// wallets and name never leak through labels. Address-book entries stay
// private to their owner: another member's labels can neither leak their
// book nor let a member stamp a spoofed name onto shared history.
async function loadChainLabels(db: Db, signer: Option.Option<string>) {
  const signerAddress = Option.getOrNull(signer)
  const memberVisible = (() => {
    if (!signerAddress) return eq(users.isPublic, true)
    if (isAdminAddress(signerAddress)) return undefined
    return or(eq(users.isPublic, true), addressLinkedToUser(signerAddress))
  })()
  const ownBook =
    signerAddress === null
      ? sql`false`
      : isAdminAddress(signerAddress)
        ? undefined
        : sql`${addressBook.userId} in (select id from ${users} where ${addressLinkedToUser(signerAddress)})`
  const [memberRows, aliasRows, bookRows, tokenRows] = await Promise.all([
    db.select({ address: users.address, name: users.name }).from(users).where(memberVisible),
    db
      .select({ address: userAddresses.address, name: users.name })
      .from(userAddresses)
      .innerJoin(users, eq(userAddresses.userId, users.id))
      .where(memberVisible),
    db
      .select({ address: addressBook.address, label: addressBook.label, type: addressBook.type })
      .from(addressBook)
      .where(ownBook),
    db.select({ address: tokens.address, symbol: tokens.symbol }).from(tokens),
  ])

  const labels = new Map<string, { kind: ChainLabelRow['kind']; label: string }>()
  labels.set(FIMS_TREASURY_ADDRESS, { kind: 'treasury', label: 'FiMs Treasury' })
  labels.set(FIMS_TONTINE_ADDRESS, { kind: 'tontine', label: 'Tontine' })
  const put = (address: string, kind: ChainLabelRow['kind'], label: string) => {
    if (!labels.has(address)) labels.set(address, { kind, label })
  }
  for (const row of bookRows) {
    put(row.address, row.type === 'other' ? 'other' : 'cex', row.label || row.type)
  }
  for (const row of memberRows) put(row.address, 'member', row.name)
  for (const row of aliasRows) put(row.address, 'member', row.name)

  const symbols = new Map<string, string>()
  for (const row of tokenRows) {
    if (row.address) symbols.set(row.address, row.symbol)
  }

  const rows: ChainLabelRow[] = [...labels.entries()].map(([address, { kind, label }]) => ({
    address,
    kind,
    label,
  }))
  return { labels, rows, symbols }
}

// Upstream failures never reach the client verbatim — an RPC error body or
// a fetch error can embed the endpoint URL (and its ?api-key). Detail stays
// in the server logs; the member gets a generic, retryable reason.
const chainUnavailable = (cause: unknown) => {
  console.error('chain provider failure', cause)
  return new ChainUnavailable({ reason: 'chain provider temporarily unavailable — retry shortly' })
}

// The chain reader proxies PAID Helius calls — an abused wallet key must not
// be able to burn the shared provider budget. Three buckets over the
// rate_limits retention window (rows purge after ~10 min): per signer, per
// client IP (a throwaway keypair per request dodges the signer bucket, the
// IP does not) and one global ceiling bounding the whole Helius spend.
const CHAIN_WINDOW_MS = 10 * 60 * 1000
const chainQuotas = () => ({
  global: envInt('CHAIN_READS_GLOBAL_PER_WINDOW', 3000),
  ip: envInt('CHAIN_READS_PER_IP_PER_WINDOW', 120),
  signer: envInt('CHAIN_READS_PER_SIGNER_PER_WINDOW', 60),
})

// Same edge-stamped header policy as the HTTP rate limiter (index.ts): read
// exactly one platform-owned header, never a client-mergeable chain.
const chainClientIp = (request: HttpServerRequest.HttpServerRequest) => {
  const name = (process.env['RATE_LIMIT_IP_HEADER'] ?? 'x-vercel-forwarded-for').toLowerCase()
  return (
    Option.getOrElse(Headers.get(request.headers, name), () => '')
      .split(',')[0]
      ?.trim() || 'unknown'
  )
}

const bumpBucket = (bucket: string) =>
  Effect.gen(function* () {
    const { db } = yield* DatabaseService
    const windowStart = new Date(Math.floor(Date.now() / CHAIN_WINDOW_MS) * CHAIN_WINDOW_MS)
    const result = yield* Effect.tryPromise({
      catch: () => new RateLimited({ reason: 'rate limiter unavailable' }),
      try: () =>
        db.execute(sql`
          INSERT INTO rate_limits (bucket, window_start, count)
          VALUES (${bucket}, ${windowStart.toISOString()}, 1)
          ON CONFLICT (bucket, window_start) DO UPDATE SET count = rate_limits.count + 1
          RETURNING count
        `),
    })
    return Number((result as unknown as { rows?: { count: number }[] }).rows?.[0]?.count ?? 0)
  })

const consumeChainQuota = (request: HttpServerRequest.HttpServerRequest, signer: string) =>
  Effect.gen(function* () {
    const quotas = chainQuotas()
    const [bySigner, byIp, global] = yield* Effect.all([
      bumpBucket(`chain:signer:${signer}`),
      bumpBucket(`chain:ip:${chainClientIp(request)}`),
      bumpBucket('chain:global'),
    ])
    if (bySigner > quotas.signer || byIp > quotas.ip || global > quotas.global) {
      return yield* Effect.fail(new RateLimited({ reason: 'chain read quota exceeded — retry in a few minutes' }))
    }
  })

// The proxy burns a PAID Helius budget and exposes member history — it is
// NOT a public indexer (audit M-8). A signer may read:
//   - protocol addresses the product displays (tontine pot, treasury);
//   - its own address, and every address linked to its member (canonical +
//     aliases);
//   - addresses in its member's own address book (how a watched account is
//     made readable);
//   - members that chose a public profile (their dashboard is public anyway).
// Admins stay unrestricted. Anything else — unknown OR private member —
// fails with the SAME error, so the endpoint is not a membership oracle.
const CHAIN_PUBLIC_TARGETS = new Set([FIMS_TONTINE_ADDRESS, FIMS_TREASURY_ADDRESS])
export const chainTargetAllowed = async (db: Db, signer: string, target: string): Promise<boolean> => {
  if (isAdminAddress(signer) || CHAIN_PUBLIC_TARGETS.has(target) || signer === target) return true
  const rows = await db.execute(sql`
    WITH me AS (
      SELECT ${users.id} AS id FROM ${users} WHERE ${addressLinkedToUser(signer)} LIMIT 1
    ),
    target_member AS (
      SELECT ${users.id} AS id, ${users.isPublic} AS is_public FROM ${users}
      WHERE ${users.address} = ${target}
        OR ${users.id} IN (SELECT ${userAddresses.userId} FROM ${userAddresses} WHERE ${userAddresses.address} = ${target})
      LIMIT 1
    )
    SELECT
      EXISTS (SELECT 1 FROM me JOIN target_member ON me.id = target_member.id) AS own,
      EXISTS (SELECT 1 FROM target_member WHERE is_public) AS public_member,
      EXISTS (
        SELECT 1 FROM ${addressBook} WHERE ${addressBook.address} = ${target}
          AND ${addressBook.userId} IN (SELECT id FROM me)
      ) AS in_book
  `)
  const row = (rows as unknown as { rows?: { in_book: boolean; own: boolean; public_member: boolean }[] }).rows?.[0]
  return !!row && (row.own || row.public_member || row.in_book)
}

const assertChainAddressAllowed = (signer: string, target: string) =>
  Effect.gen(function* () {
    const allowed = yield* withDb((db) => chainTargetAllowed(db, signer, target))
    if (!allowed) {
      return yield* Effect.fail(new AuthForbidden({ address: signer }))
    }
  })

const heliusKeysOrFail = Effect.gen(function* () {
  const keys = heliusApiKeys()
  if (!keys.length) return yield* Effect.fail(new ChainUnavailable({ reason: 'HELIUS_API_KEY is not configured' }))
  return keys
})
