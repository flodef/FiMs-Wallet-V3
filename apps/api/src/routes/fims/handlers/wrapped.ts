import { HttpServerRequest } from '@effect/platform'
import { address as solAddress } from '@solana/kit'
import { and, eq, inArray, like, sql } from 'drizzle-orm'
import { Effect, type Schema } from 'effect'
import {
  custodialAddress,
  custodialMint,
  custodialRedeem,
  type FimsWrappedProduct,
  productForBackingMint,
  productForWrappedMint,
  redeemLiquidity,
  wrappedProductConfig,
} from '../../../custodial.js'
import { tokens, transactions, users, wrappedClaims } from '../../../db/schema.js'
import { withDb, withTransaction } from '../../../db/service.js'
import { getFimsFeeRate } from '../../../fee-config.js'
import { requireNotDemo, verifyWalletRequest } from '../../../services/auth/service.js'
import { fetchDonationTransaction } from '../../../solana-rpc.js'
import { formatTokenUnits } from '../../../solana-util.js'
import { BadRequest, CustodialUnavailable, type WrappedTxBody } from '../api.js'
import {
  addressLinkedToUser,
  insertFailed,
  lastImpliedWrappedPrice,
  PRICE_STALE_MS,
  requireMember,
  wrappedDailyCap,
  wrappedPriceBreaker,
} from '../helpers.js'

// Sentinel thrown inside the claim transaction when another runner already
// owns a leg — withTransaction aborts and rolls back, so fresh 'claimed'
// inserts and any pending wins this transaction made never commit. A plain
// `return { inFlight: true }` would COMMIT them and wedge legs as 'claimed'
// with no executor (HTTP then reports inFlight, the keeper only scans
// 'awaiting_liquidity' — manual admin unblock required).
class WrappedClaimInFlight extends Error {}

export const handleWrappedConfig = () =>
  Effect.gen(function* () {
    const custody = yield* Effect.tryPromise({
      catch: () => null,
      try: () => custodialAddress(),
    }).pipe(Effect.orElseSucceed(() => null))
    const products = (['fims-eur', 'fims-usd'] as const).flatMap((id) => {
      const config = wrappedProductConfig(id)
      return config
        ? [
            {
              backingMint: `${config.backingMint}`,
              id,
              mint: `${config.mint}`,
              symbol: config.symbol,
            },
          ]
        : []
    })
    return { custody, products }
  })

export const handleWrappedDeposit = ({ payload }: { payload: Schema.Schema.Type<typeof WrappedTxBody> }) =>
  Effect.gen(function* () {
    return yield* wrappedTransfer(payload.signature, 'deposit')
  })

export const handleWrappedRedeem = ({ payload }: { payload: Schema.Schema.Type<typeof WrappedTxBody> }) =>
  Effect.gen(function* () {
    return yield* wrappedTransfer(payload.signature, 'redeem')
  })

// Shared deposit/redeem pipeline: verify the member's on-chain transfer into
// custody, then let the custodial mint (deposit) or burn+refund (redeem).
// The ledger row is written in the wrapped symbol (EURF/USDF) at the current
// NAV — circuit breakers below bound what a manipulated index can do.
export function wrappedTransfer(signature: string, direction: 'deposit' | 'redeem') {
  return Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest
    const signer = yield* verifyWalletRequest(request)
    yield* requireNotDemo(signer)
    const member = yield* requireMember(signer)
    // Only wrapped ledger rows ({sig}:{mint}) count as "already processed":
    // a transaction can ALSO appear as a donation row (same signature, no
    // suffix) when it carried a tontine carve — that must not block the mint.
    // Scoped to THIS member's rows — an unscoped hit would leak another
    // member's wrapped legs (wrapped signatures are enumerable from the
    // custody wallet's on-chain history) before the payer-link check runs.
    const existing = yield* withDb((db) =>
      db
        .select()
        .from(transactions)
        .where(and(like(transactions.signature, `${signature}:%`), eq(transactions.userId, member.id))),
    )
    if (existing.length) {
      return { custodialSignature: '', transactions: existing }
    }

    const custody = yield* Effect.tryPromise({
      catch: (error) => {
        console.error('custodial wallet unavailable', error)
        return new CustodialUnavailable({ reason: 'custodial wallet is not configured' })
      },
      try: () => custodialAddress(),
    })
    const tx = yield* Effect.tryPromise({
      catch: () => new BadRequest({ reason: 'cannot fetch transaction from the RPC' }),

      // Finalized only: minting irreversible wrapped units against a
      // merely-confirmed member transfer is not worth the reorg risk.
      try: () => fetchDonationTransaction(signature, `${custody}`, 'finalized'),
    })
    if (!tx) return yield* Effect.fail(new BadRequest({ reason: 'transaction not found, failed, or not finalized' }))
    const matches = tx.deltas
      .map((delta) => ({
        delta,
        product: direction === 'deposit' ? productForBackingMint(delta.mint) : productForWrappedMint(delta.mint),
      }))
      // Minting irreversible units requires the payer to have funded the
      // deposit leg — not a third party riding the same tx (audit H-3).
      .filter((entry) => entry.product != null && entry.delta.payerSourced)
    if (!matches.length)
      return yield* Effect.fail(
        new BadRequest({
          reason:
            direction === 'deposit'
              ? 'transaction did not credit custody with EURC or USDG'
              : 'transaction did not return a wrapped FiMs token to custody',
        }),
      )
    const payerRows = yield* withDb((db) =>
      db.select({ id: users.id }).from(users).where(addressLinkedToUser(tx.payer)),
    )
    if (payerRows[0]?.id !== member.id)
      return yield* Effect.fail(new BadRequest({ reason: 'transaction sender is not linked to your member account' }))

    // Product units are priced by the operator-maintained index in `tokens`
    // (EURF tracks the FiMs Token NAV, USDF starts at 1), under three
    // circuit breakers:
    //   1. freshness — a stalled feed freezes mint/redeem (like convertPosition);
    //   2. rate-of-change — the index may not deviate more than
    //      FIMS_WRAPPED_PRICE_BREAKER (default 10%) from the price implied by
    //      the member's previous wrapped ledger row, so a manipulated or
    //      lagging feed cannot reprice a mint instantly;
    //   3. rolling-24h caps — per member and global, bounding what a stolen
    //      key or a bad price can move before humans react.
    // A symmetric operating fee (getFimsFeeRate) prices the spread that would
    // otherwise make NAV-lag arbitrage free.
    const prepared: {
      backingUnits: bigint
      delta: (typeof matches)[number]['delta']
      price: number
      product: FimsWrappedProduct
      productUnits: bigint
      symbol: string
    }[] = []
    for (const { delta, product } of matches) {
      const config = wrappedProductConfig(product as FimsWrappedProduct)
      if (!config) return yield* Effect.fail(new CustodialUnavailable({ reason: `${product} mint is not configured` }))
      if (delta.decimals !== 6)
        return yield* Effect.fail(new CustodialUnavailable({ reason: `${product} mint expects 6-decimal tokens` }))
      const tokenRows = yield* withDb((db) =>
        db
          .select({ updatedAt: tokens.updatedAt, value: tokens.value })
          .from(tokens)
          .where(eq(tokens.symbol, config.symbol)),
      )
      const tokenRow = tokenRows[0]
      const price = tokenRow?.value ?? 0
      if (price <= 0 || !tokenRow)
        return yield* Effect.fail(
          new CustodialUnavailable({ reason: `${config.symbol} price index is not configured` }),
        )
      if (Date.now() - tokenRow.updatedAt.getTime() > PRICE_STALE_MS)
        return yield* Effect.fail(
          new CustodialUnavailable({
            reason: `stale price for ${config.symbol}: ${tokenRow.updatedAt.toISOString()}`,
          }),
        )
      const lastImplied = yield* withDb((db) => lastImpliedWrappedPrice(db, config.symbol))
      if (lastImplied && Math.abs(price / lastImplied - 1) > wrappedPriceBreaker())
        return yield* Effect.fail(
          new CustodialUnavailable({
            reason: `${config.symbol} price moved ${(Math.abs(price / lastImplied - 1) * 100).toFixed(1)}% — circuit breaker`,
          }),
        )
      // Exact integer math: price and the fee are scaled to 1e9 fractions.
      const priceScaled = BigInt(Math.round(price * 1e9))
      const feeScaled = BigInt(Math.round((1 - getFimsFeeRate()) * 1e9))
      const received = delta.rawAmount
      const backingUnits =
        direction === 'deposit' ? received : (received * priceScaled * feeScaled) / 1_000_000_000_000_000_000n
      const productUnits = direction === 'deposit' ? (received * feeScaled) / priceScaled : received
      if (productUnits <= 0n || backingUnits <= 0n)
        return yield* Effect.fail(new BadRequest({ reason: 'amount too small' }))
      prepared.push({
        backingUnits,
        delta,
        price,
        product: product as FimsWrappedProduct,
        productUnits,
        symbol: config.symbol,
      })
    }

    // Liquidity snapshot BEFORE the member lock — `redeemLiquidity` is
    // several RPC round-trips and must not run inside `withTransaction`
    // while the FOR UPDATE row lock serializes this member's wrapped ops.
    // A stale answer is harmless: too-low liquidity only queues a claim the
    // keeper retries, and a stale "enough" just fails custodialRedeem.
    const liquidity = new Map<FimsWrappedProduct, bigint>()
    if (direction === 'redeem') {
      for (const product of new Set(prepared.map((row) => row.product))) {
        liquidity.set(
          product,
          yield* Effect.tryPromise({
            catch: () => new CustodialUnavailable({ reason: 'custodial liquidity check failed' }),
            try: () => redeemLiquidity(product),
          }),
        )
      }
    }

    // State machine, not a blind mint: wrapped_claims records each leg's
    // progress (claimed → minted → recorded). A crash mid-flight leaves a
    // durable mark a retry can resume from instead of re-minting or
    // blocking forever — see the wrapped_claims table comment for states.
    const claimOutcome = yield* withTransaction(async (tx) => {
      await tx.execute(sql`SELECT id FROM users WHERE id = ${member.id} FOR UPDATE`)
      const mints = prepared.map((row) => row.delta.mint)
      const existing = await tx
        .select()
        .from(wrappedClaims)
        .where(and(eq(wrappedClaims.signature, signature), inArray(wrappedClaims.mint, mints)))
      const byMint = new Map(existing.map((claim) => [claim.mint, claim]))
      // A 'claimed' leg means a previous request died between claim and
      // ledger write — a retried mint could double-credit the member, so it
      // blocks until an admin verifies the chain and unblocks the row.
      if (existing.some((claim) => claim.state === 'claimed')) return { inFlight: true } as const
      // 'minted' legs retry only the ledger write — carry the signature
      // their earlier custodial call produced into the response.
      const replay = prepared
        .filter((row) => byMint.get(row.delta.mint)?.state === 'minted')
        .map((row) => ({
          ...row,
          custodialSignature: byMint.get(row.delta.mint)?.custodialSignature ?? undefined,
        }))
      // 'awaiting_liquidity' legs were already vetted (signature, caps) but
      // could not settle for lack of float — they retry execution here and
      // in the keeper pass without re-counting the daily caps.
      const pending = prepared.filter((row) => byMint.get(row.delta.mint)?.state === 'awaiting_liquidity')
      const fresh = prepared.filter((row) => !byMint.has(row.delta.mint))
      // Caps only gate NEW legs — replaying a minted leg's ledger row must
      // never be refused (the units are already on-chain).
      const symbols = fresh.map((row) => row.symbol)
      if (symbols.length) {
        const memberUnits = (
          await tx.execute(
            sql`SELECT COALESCE(SUM(ABS(amount)), 0)::float AS units FROM transactions WHERE user_id = ${member.id} AND ${inArray(transactions.token, symbols)} AND type IN ('deposit', 'withdrawal') AND date >= NOW() - INTERVAL '24 hours'`,
          )
        ).rows as { units: number }[]
        const globalUnits = (
          await tx.execute(
            sql`SELECT COALESCE(SUM(ABS(amount)), 0)::float AS units FROM transactions WHERE ${inArray(transactions.token, symbols)} AND type IN ('deposit', 'withdrawal') AND date >= NOW() - INTERVAL '24 hours'`,
          )
        ).rows as { units: number }[]
        const requested = fresh.reduce((sum, row) => sum + Number(row.productUnits) / 1e6, 0)
        if (Number(memberUnits[0]?.units ?? 0) + requested > wrappedDailyCap('member'))
          return { limited: 'member daily wrapped limit exceeded' } as const
        if (Number(globalUnits[0]?.units ?? 0) + requested > wrappedDailyCap('global'))
          return { limited: 'global daily wrapped limit exceeded' } as const
      }
      // Liquidity gate (redeem only): without a yield venue the float alone
      // must cover the withdrawal — a shortfall queues the claim instead of
      // wedging it as 'claimed' forever (audit M-4). The claim was already
      // vetted; the keeper settles it once liquidity is topped up.
      const executable = [...fresh, ...pending]
      if (direction === 'redeem' && executable.length) {
        const needed = new Map<FimsWrappedProduct, bigint>()
        for (const row of executable) {
          needed.set(row.product, (needed.get(row.product) ?? 0n) + row.backingUnits)
        }
        for (const [product, units] of needed) {
          const available = liquidity.get(product) ?? 0n
          if (units > available) {
            for (const row of fresh) {
              await tx
                .insert(wrappedClaims)
                .values({ mint: row.delta.mint, signature, state: 'awaiting_liquidity' })
                .onConflictDoNothing()
            }
            // A fresh leg queueing must not wedge a minted leg's ledger
            // write — settle the replay, leave the queue for the keeper.
            return replay.length ? ({ fresh: [], replay } as const) : ({ queued: product } as const)
          }
        }
      }
      for (const row of fresh) {
        await tx.insert(wrappedClaims).values({ mint: row.delta.mint, signature, state: 'claimed' })
      }
      for (const row of pending) {
        // State-predicated transition: the keeper's queued-redeem settle
        // moves the same row awaiting_liquidity → claimed outside this
        // lock — if it won, our update is empty and we must NOT proceed
        // (the other runner owns the on-chain payout now).
        const transitioned = await tx
          .update(wrappedClaims)
          .set({ state: 'claimed', updatedAt: new Date() })
          .where(
            and(
              eq(wrappedClaims.signature, signature),
              eq(wrappedClaims.mint, row.delta.mint),
              eq(wrappedClaims.state, 'awaiting_liquidity'),
            ),
          )
          .returning({ mint: wrappedClaims.mint })
        if (!transitioned.length) throw new WrappedClaimInFlight()
      }
      return { fresh: executable, replay } as const
    }).pipe(
      Effect.catchTag('DatabaseError', (error) =>
        error.cause instanceof WrappedClaimInFlight ? Effect.succeed({ inFlight: true } as const) : Effect.fail(error),
      ),
    )
    if ('inFlight' in claimOutcome)
      return yield* Effect.fail(
        new BadRequest({ reason: 'this transfer is already being processed — retry in a minute' }),
      )
    if ('limited' in claimOutcome) return yield* Effect.fail(new BadRequest({ reason: claimOutcome.limited }))
    if ('queued' in claimOutcome)
      return yield* Effect.fail(
        new CustodialUnavailable({
          reason: `${claimOutcome.queued} redeem queued — liquidity is being provisioned and it will settle automatically`,
        }),
      )
    const { fresh, replay } = claimOutcome
    if (!fresh.length && !replay.length) {
      const rows = yield* withDb((db) =>
        db
          .select()
          .from(transactions)
          .where(and(like(transactions.signature, `${signature}:%`), eq(transactions.userId, member.id))),
      )
      return { custodialSignature: '', transactions: rows }
    }

    // Mint each fresh leg, then durably mark it minted — a retry replays the
    // ledger write without touching the chain again.
    const minted: ({ custodialSignature?: string | undefined } & (typeof fresh)[number])[] = [...replay]
    for (const row of fresh) {
      const custodialSignature = yield* Effect.tryPromise({
        catch: (error) => {
          console.error(`custodial ${direction} failed`, error)
          return new CustodialUnavailable({
            reason: `custodial ${direction} failed — the backing is safe; retry in a few minutes`,
          })
        },
        try: () =>
          direction === 'deposit'
            ? custodialMint(row.product, solAddress(tx.payer), row.productUnits, row.backingUnits)
            : custodialRedeem(row.product, solAddress(tx.payer), row.productUnits, row.backingUnits),
      })
      const mintedTransition = yield* withDb((db) =>
        db
          .update(wrappedClaims)
          .set({ custodialSignature, state: 'minted', updatedAt: new Date() })
          .where(
            and(
              eq(wrappedClaims.signature, signature),
              eq(wrappedClaims.mint, row.delta.mint),
              // State-predicated: our claim must still be 'claimed' — an
              // empty update means another path owns the row now, and the
              // recorded guard below must not write its ledger row.
              eq(wrappedClaims.state, 'claimed'),
            ),
          )
          .returning({ mint: wrappedClaims.mint }),
      )
      if (!mintedTransition.length) {
        console.error(`wrapped claim ${signature}:${row.delta.mint} moved unexpectedly after custodial ${direction}`)
        continue
      }
      minted.push({ ...row, custodialSignature })
    }

    // Ledger rows + terminal state in one transaction per leg.
    const rows = []
    let custodialSignature = minted[0]?.custodialSignature ?? ''
    for (const row of minted) {
      const productAmount = Number(row.productUnits) / 1e6
      const movement = row.price * productAmount
      const inserted = yield* withTransaction(async (dbTx) => {
        // Flip the claim to 'recorded' FIRST — the update is empty when
        // another path already recorded the leg (e.g. a concurrent keeper
        // settle), and then the ledger insert must not happen: it would
        // duplicate the row (`transactions.signature` has no unique key).
        const recorded = await dbTx
          .update(wrappedClaims)
          .set({ state: 'recorded', updatedAt: new Date() })
          .where(
            and(
              eq(wrappedClaims.signature, signature),
              eq(wrappedClaims.mint, row.delta.mint),
              eq(wrappedClaims.state, 'minted'),
            ),
          )
          .returning({ mint: wrappedClaims.mint })
        if (!recorded.length) return []
        return await dbTx
          .insert(transactions)
          .values({
            address: tx.payer,
            amount:
              direction === 'deposit' ? formatTokenUnits(row.productUnits, 6) : formatTokenUnits(-row.productUnits, 6),
            cost: movement,
            date: tx.blockTime ?? new Date(),
            movement: direction === 'deposit' ? movement : -movement,
            signature: `${signature}:${row.delta.mint}`,
            token: row.symbol,
            type: direction === 'deposit' ? ('deposit' as const) : ('withdrawal' as const),
            userId: member.id,
          })
          .returning()
      })
      custodialSignature = row.custodialSignature ?? custodialSignature
      rows.push(...inserted)
    }
    if (!rows.length) {
      // Every leg was recorded by a concurrent path — the rows exist, just
      // not written by this request (still scoped to the caller's rows).
      const existing = yield* withDb((db) =>
        db
          .select()
          .from(transactions)
          .where(and(like(transactions.signature, `${signature}:%`), eq(transactions.userId, member.id))),
      )
      if (existing.length) return { custodialSignature, transactions: existing }
      return yield* Effect.fail(insertFailed())
    }
    return { custodialSignature, transactions: rows }
  })
}
