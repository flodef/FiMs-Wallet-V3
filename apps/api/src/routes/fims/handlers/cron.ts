import { HttpServerRequest } from '@effect/platform'
import { Effect } from 'effect'
import { custodialBackingStatus, custodialSweep } from '../../../custodial.js'
import { tokens } from '../../../db/schema.js'
import { DatabaseError, DatabaseService } from '../../../db/service.js'
import { AuthUnauthorized } from '../../../services/auth/service.js'
import { cronAuthorized, runStrategyPass, strategyHealth } from '../../../strategy-delegate.js'
import { reconcileTontineDonations } from '../../../tontine-reconcile.js'
import { processQueuedRedeems } from '../../../wrapped-reconcile.js'
import { ChainUnavailable } from '../api.js'

export const handleStrategyStatus = () =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest
    if (!cronAuthorized(request.headers['x-strategy-secret'] ?? null)) {
      return yield* Effect.fail(new AuthUnauthorized({ reason: 'invalid x-strategy-secret' }))
    }
    const { db } = yield* DatabaseService
    const health = yield* Effect.tryPromise({
      catch: (cause) => new DatabaseError({ cause }),
      try: () => strategyHealth(db),
    })
    // 503 (not 200-with-issues) so the uptime monitor fires on any
    // problem: stale pending deposits, failed ops, delegate broke.
    if (!health.healthy) {
      return yield* Effect.fail(new ChainUnavailable({ reason: health.issues.join('; ') }))
    }
    return health
  })

export const handleStrategyDelegateRun = () =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest
    if (!cronAuthorized(request.headers['x-strategy-secret'] ?? null)) {
      return yield* Effect.fail(new AuthUnauthorized({ reason: 'invalid x-strategy-secret' }))
    }
    const { db } = yield* DatabaseService
    const report = yield* Effect.tryPromise({
      catch: (cause) =>
        new ChainUnavailable({ reason: cause instanceof Error ? cause.message : 'delegate pass failed' }),
      try: () => runStrategyPass(db),
    })
    // Piggyback the tontine reconcile on the same cron tick: the pot
    // sees so few transactions that one scan a minute is plenty, and
    // carving sends no longer depend on the client reporting them.
    // Best-effort — a reconcile hiccup must not fail the keeper pass.
    yield* Effect.tryPromise({
      catch: () => new ChainUnavailable({ reason: 'reconcile failed' }),
      try: () => reconcileTontineDonations(db),
    }).pipe(Effect.catchAll((error) => Effect.logWarning('tontine reconcile failed', error)))
    // Settle queued redeems on the same tick — a member whose withdrawal
    // found no float gets paid as soon as liquidity is topped up.
    yield* Effect.tryPromise({
      catch: () => new ChainUnavailable({ reason: 'queued redeem failed' }),
      try: () => processQueuedRedeems(db),
    }).pipe(Effect.catchAll((error) => Effect.logWarning('queued redeem settle failed', error)))
    // Surface per-deposit failures as 503 so cron-job.org alerts —
    // the full detail stays in the strategy_ops table.
    const failed = report.deposits.filter((d) => d.error)
    if (failed.length > 0) {
      return yield* Effect.fail(
        new ChainUnavailable({ reason: failed.map((d) => `${d.member}: ${d.error}`).join('; ') }),
      )
    }
    return report
  })

export const handleCustodialBackingStatus = () =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest
    if (!cronAuthorized(request.headers['x-strategy-secret'] ?? null)) {
      return yield* Effect.fail(new AuthUnauthorized({ reason: 'invalid x-strategy-secret' }))
    }
    const { db } = yield* DatabaseService
    const rows = yield* Effect.tryPromise({
      catch: (cause) =>
        new ChainUnavailable({ reason: cause instanceof Error ? cause.message : 'backing status failed' }),
      try: async () => {
        const tokenRows = await db.select().from(tokens)
        const prices = Object.fromEntries(
          tokenRows.filter((row) => row.value !== null).map((row) => [row.symbol, row.value as number]),
        )
        return custodialBackingStatus(prices)
      },
    })
    const unbacked = rows.filter((row) => !row.healthy)
    if (unbacked.length > 0) {
      return yield* Effect.fail(
        new ChainUnavailable({
          reason: `unbacked supply: ${unbacked.map((row) => row.product).join(', ')}`,
        }),
      )
    }
    return { products: rows }
  })

export const handleCustodialSweep = () =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest
    if (!cronAuthorized(request.headers['x-strategy-secret'] ?? null)) {
      return yield* Effect.fail(new AuthUnauthorized({ reason: 'invalid x-strategy-secret' }))
    }
    const report = yield* Effect.tryPromise({
      catch: (cause) => new ChainUnavailable({ reason: cause instanceof Error ? cause.message : 'sweep failed' }),
      try: async () => {
        const out = []
        for (const product of ['fims-eur', 'fims-usd'] as const) {
          out.push(await custodialSweep(product))
        }
        return out
      },
    })
    return report.map((row) => ({
      product: row.product,
      signature: row.signature,
      swept: row.swept.toString(),
    }))
  })
