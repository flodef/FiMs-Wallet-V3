import { HttpServerRequest } from '@effect/platform'
import { eq, or, sql } from 'drizzle-orm'
import { Effect, Option } from 'effect'
import { addressBook, tokens, userAddresses, users } from '../../../db/schema.js'
import { DatabaseService, type Db, withDb } from '../../../db/service.js'
import { FIMS_TONTINE_ADDRESS, FIMS_TREASURY_ADDRESS } from '../../../fims-constants.js'
import {
  chainSymbolForMint,
  fetchHeliusAssets,
  fetchHeliusTransactions,
  heliusApiKeys,
  normalizeGtfaTransaction,
} from '../../../helius.js'
import { isAdminAddress, verifyWalletRequest } from '../../../services/auth/service.js'
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
    yield* consumeChainQuota(signer)
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
    yield* consumeChainQuota(signer)
    yield* assertChainAddressAllowed(signer, urlParams.address)
    const keys = yield* heliusKeysOrFail
    const assets = yield* Effect.tryPromise({
      catch: chainUnavailable,
      try: () => fetchHeliusAssets(keys, urlParams.address),
    })
    const { symbols } = yield* withDb((db) => loadChainLabels(db, Option.some(signer)))
    return assets.map((asset) => ({
      ...asset,
      symbol: asset.mint ? (asset.symbol ?? chainSymbolForMint(asset.mint, symbols)) : 'SOL',
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
// be able to burn the shared provider budget. Per-signer bucket over the
// rate_limits retention window (rows purge after ~10 min); generous enough
// for normal browsing, hard against scripted scraping.
const CHAIN_READS_PER_WINDOW = 60
const consumeChainQuota = (signer: string) =>
  Effect.gen(function* () {
    const { db } = yield* DatabaseService
    const windowStart = new Date(Math.floor(Date.now() / (10 * 60 * 1000)) * 10 * 60 * 1000)
    const result = yield* Effect.tryPromise({
      catch: () => new RateLimited({ reason: 'rate limiter unavailable' }),
      try: () =>
        db.execute(sql`
          INSERT INTO rate_limits (bucket, window_start, count)
          VALUES (${`chain:${signer}`}, ${windowStart.toISOString()}, 1)
          ON CONFLICT (bucket, window_start) DO UPDATE SET count = rate_limits.count + 1
          RETURNING count
        `),
    })
    const count = Number((result as unknown as { rows?: { count: number }[] }).rows?.[0]?.count ?? 0)
    if (count > CHAIN_READS_PER_WINDOW) {
      return yield* Effect.fail(
        new RateLimited({ reason: `chain read quota exceeded (${CHAIN_READS_PER_WINDOW} per 10 minutes)` }),
      )
    }
  })

// The proxy burns a PAID Helius budget — arbitrary addresses would make the
// API a free indexer for anyone holding a member key (audit M-8). Members may
// only query their own linked wallets plus protocol addresses the product
// legitimately displays (tontine pot, treasury). Admins stay unrestricted.
const CHAIN_PUBLIC_TARGETS = new Set([FIMS_TONTINE_ADDRESS, FIMS_TREASURY_ADDRESS])
const assertChainAddressAllowed = (signer: string, target: string) =>
  Effect.gen(function* () {
    if (isAdminAddress(signer) || CHAIN_PUBLIC_TARGETS.has(target)) return
    const linked = yield* withDb(async (db) => {
      const member = await db
        .select({ address: users.address, id: users.id })
        .from(users)
        .where(addressLinkedToUser(signer))
      if (!member[0]) return []
      const aliases = await db
        .select({ address: userAddresses.address })
        .from(userAddresses)
        .where(eq(userAddresses.userId, member[0].id))
      return [member[0].address, ...aliases.map((row) => row.address)]
    })
    if (!linked.includes(target)) {
      return yield* Effect.fail(new RateLimited({ reason: 'chain reads are limited to your linked addresses' }))
    }
  })

const heliusKeysOrFail = Effect.gen(function* () {
  const keys = heliusApiKeys()
  if (!keys.length) return yield* Effect.fail(new ChainUnavailable({ reason: 'HELIUS_API_KEY is not configured' }))
  return keys
})
