import { HttpServerRequest } from '@effect/platform'
import { and, asc, eq, inArray, sql } from 'drizzle-orm'
import { Effect, type Schema } from 'effect'
import { tokens, transactions } from '../../../db/schema.js'
import { withDb, withTransaction } from '../../../db/service.js'
import { getFimsFeeRate } from '../../../fee-config.js'
import { requireNotDemo, verifyWalletRequest } from '../../../services/auth/service.js'
import { BadRequest, type ConvertPositionBody } from '../api.js'
import { insertFailed, MAX_DAILY_CONVERT_EUR, PRICE_STALE_MS, requireMember } from '../helpers.js'

export const handleConvertPosition = ({ payload }: { payload: Schema.Schema.Type<typeof ConvertPositionBody> }) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest
    const signer = yield* verifyWalletRequest(request)
    yield* requireNotDemo(signer)
    const member = yield* requireMember(signer)
    if (payload.fromToken === payload.toToken)
      return yield* Effect.fail(new BadRequest({ reason: 'source and destination tokens must differ' }))
    const priceRows = yield* withDb((db) =>
      db
        .select({ symbol: tokens.symbol, updatedAt: tokens.updatedAt, value: tokens.value })
        .from(tokens)
        .where(inArray(tokens.symbol, [payload.fromToken, payload.toToken])),
    )
    const priceOf = new Map(priceRows.map((r) => [r.symbol, r]))
    const fromToken = priceOf.get(payload.fromToken)
    const toToken = priceOf.get(payload.toToken)
    const fromPrice = fromToken?.value
    const toPrice = toToken?.value
    if (fromPrice == null || fromPrice <= 0 || toPrice == null || toPrice <= 0)
      return yield* Effect.fail(new BadRequest({ reason: 'unknown or unpriced token' }))
    // A stale price is a free option against the treasury: if the
    // feed stalls, conversions stop instead of trading at it.
    for (const token of [fromToken, toToken]) {
      if (token && Date.now() - token.updatedAt.getTime() > PRICE_STALE_MS)
        return yield* Effect.fail(
          new BadRequest({
            reason: `stale price for ${token.symbol}: ${token.updatedAt.toISOString()}`,
          }),
        )
    }
    const now = new Date()
    // Session-level transaction: the member row lock serializes
    // concurrent conversions so each one re-reads the position AND
    // the daily cap under the lock before writing — a racy
    // double-read can no longer overdraw the position nor double
    // the daily quota. (user_id, request_id) is unique, so a
    // retried submission is deduplicated.
    const outcome = yield* withTransaction(async (tx) => {
      await tx.execute(sql`SELECT id FROM users WHERE id = ${member.id} FOR UPDATE`)
      // The per-day cap bounds what a stolen member key can bleed
      // through back-and-forth conversions (each round-trip burns
      // the fee). Checked under the member lock — parallel requests
      // cannot both see headroom and slip past the cap.
      const dailyRows = (
        await tx.execute(
          sql`SELECT COALESCE(SUM(-movement), 0)::float AS eur FROM transactions WHERE user_id = ${member.id} AND type = 'conversion' AND movement < 0 AND date >= NOW() - INTERVAL '24 hours'`,
        )
      ).rows as { eur: number }[]
      if (Number(dailyRows[0]?.eur ?? 0) + payload.eurAmount > MAX_DAILY_CONVERT_EUR) {
        return {
          capExceeded: `daily conversion limit of ${MAX_DAILY_CONVERT_EUR} EUR exceeded`,
        } as const
      }
      const lockedUnits = (
        await tx.execute(
          sql`SELECT COALESCE(SUM(amount), 0)::float AS units FROM transactions WHERE user_id = ${member.id} AND token = ${payload.fromToken}`,
        )
      ).rows as { units: number }[]
      const available = Number(lockedUnits[0]?.units ?? 0) * fromPrice
      if (payload.eurAmount > available * 1.001 + 0.01) {
        return {
          insufficient: `amount exceeds position: ${payload.eurAmount} > ${available.toFixed(2)} ${payload.fromToken}`,
        } as const
      }
      const inserted = await tx
        .insert(transactions)
        .values([
          {
            address: signer,
            amount: `${-payload.eurAmount / fromPrice}`,
            date: now,
            movement: -payload.eurAmount,
            requestId: payload.requestId,
            token: payload.fromToken,
            type: 'conversion' as const,
            userId: member.id,
          },
          {
            // Credited side is net of the operating fee — the member's
            // balance drops by the fee, which stays in the treasury.
            address: signer,
            amount: `${(payload.eurAmount * (1 - getFimsFeeRate())) / toPrice}`,
            date: now,
            movement: payload.eurAmount * (1 - getFimsFeeRate()),

            // Suffixed id keeps the credit leg tagged for dedup while
            // staying a distinct key under the (user_id, request_id)
            // unique index — the pair cannot collide with itself.
            requestId: `${payload.requestId}:credit`,
            token: payload.toToken,
            type: 'conversion' as const,
            userId: member.id,
          },
        ])
        .onConflictDoNothing({ target: [transactions.userId, transactions.requestId] })
        .returning()
      return { inserted } as const
    })
    if ('capExceeded' in outcome) return yield* Effect.fail(new BadRequest({ reason: outcome.capExceeded }))
    if ('insufficient' in outcome) return yield* Effect.fail(new BadRequest({ reason: outcome.insufficient }))
    if (outcome.inserted.length) return outcome.inserted
    // Conflict on request_id: the same conversion was already
    // applied by an earlier attempt — return that pair, don't
    // double-apply.
    const existing = yield* withDb((db) =>
      db
        .select()
        .from(transactions)
        .where(
          and(
            eq(transactions.userId, member.id),
            inArray(transactions.requestId, [payload.requestId, `${payload.requestId}:credit`]),
          ),
        )
        .orderBy(asc(transactions.id)),
    )
    if (!existing.length) return yield* Effect.fail(insertFailed())
    return existing
  })
