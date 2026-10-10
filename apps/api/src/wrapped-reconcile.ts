// Queued-redeem settlement — runs inside the keeper pass. A member redeem
// that found no float is parked as 'awaiting_liquidity' in wrapped_claims
// (audit M-4): the member's product units already sit in custody, so the
// claim — not a fresh user request — is the authorization to burn+pay out.
// Each tick re-derives the leg from the on-chain deposit transaction at the
// CURRENT operator price and settles it when liquidity is available.
//
// Concurrency: two runners must never settle the same claim (the second
// custodialRedeem would pay backing out twice — the shared product ATA
// always holds enough pending units for a second burn to succeed). All
// retryable checks run first while the row still says 'awaiting_liquidity';
// the irreversible payout is gated by an UPDATE … WHERE
// state='awaiting_liquidity' that wins exactly once per claim — against a
// user retry (the HTTP path moves the same transition) and against an
// overlapping keeper tick. The keeper lease is only a cheaper outer gate.

import { address as solAddress } from '@solana/kit'
import { and, eq } from 'drizzle-orm'
import {
  custodialAddress,
  custodialRedeem,
  type FimsWrappedProduct,
  productForWrappedMint,
  redeemLiquidity,
  wrappedProductConfig,
} from './custodial.js'
import { tokens, transactions, wrappedClaims } from './db/schema.js'
import { type Db, runTransaction } from './db/service.js'
import { getFimsFeeRate } from './fee-config.js'
import { lastImpliedWrappedPrice, PRICE_STALE_MS, wrappedPriceBreaker } from './routes/fims/helpers.js'
import { fetchDonationTransaction } from './solana-rpc.js'
import { formatTokenUnits } from './solana-util.js'
import { withKeeperLease } from './strategy-delegate.js'
import { memberLinkedTo } from './tontine-reconcile.js'

const BATCH_LIMIT = 20

export async function processQueuedRedeems(db: Db): Promise<{ attempted: number; settled: number }> {
  const report = await withKeeperLease(db, 'wrapped-redeem', () => settleQueuedRedeems(db))
  return report ?? { attempted: 0, settled: 0 }
}

async function settleQueuedRedeems(db: Db): Promise<{ attempted: number; settled: number }> {
  const claims = await db
    .select()
    .from(wrappedClaims)
    .where(eq(wrappedClaims.state, 'awaiting_liquidity'))
    .limit(BATCH_LIMIT)
  if (!claims.length) return { attempted: 0, settled: 0 }

  const custody = await custodialAddress()
  let settled = 0
  for (const claim of claims) {
    try {
      // Re-derive the leg from the member's own deposit transaction — the
      // chain is the source of truth for what was actually sent in.
      const fetched = await fetchDonationTransaction(claim.signature, `${custody}`, 'finalized')
      const delta = fetched?.deltas.find((d) => d.mint === claim.mint && d.payerSourced)
      if (!fetched || !delta) continue
      const product = productForWrappedMint(delta.mint)
      const config = product ? wrappedProductConfig(product as FimsWrappedProduct) : null
      if (!product || !config) continue
      const member = (await memberLinkedTo(db, fetched.payer))[0]
      if (!member) {
        // The payer no longer maps to a member — the ledger row can never
        // be written, so this claim would retry forever. Mark it
        // 'abandoned': it stops scanning and stays admin-visible.
        await db
          .update(wrappedClaims)
          .set({ state: 'abandoned', updatedAt: new Date() })
          .where(
            and(
              eq(wrappedClaims.signature, claim.signature),
              eq(wrappedClaims.mint, claim.mint),
              eq(wrappedClaims.state, 'awaiting_liquidity'),
            ),
          )
        continue
      }

      // Re-price at settlement time: the member locked product units at
      // deposit, the backing paid out tracks the current index (same fee).
      // The settlement must pass the SAME circuit breakers the live handler
      // applies — a queued claim must not settle at a price the user path
      // would refuse.
      const tokenRow = (
        await db
          .select({ updatedAt: tokens.updatedAt, value: tokens.value })
          .from(tokens)
          .where(eq(tokens.symbol, config.symbol))
      )[0]
      const price = tokenRow?.value ?? 0
      if (price <= 0 || !tokenRow || Date.now() - tokenRow.updatedAt.getTime() > PRICE_STALE_MS) continue
      const lastImplied = await lastImpliedWrappedPrice(db, config.symbol)
      if (lastImplied && Math.abs(price / lastImplied - 1) > wrappedPriceBreaker()) {
        console.warn(
          `queued redeem ${claim.signature}:${claim.mint} held by price breaker ` +
            `(index moved ${(Math.abs(price / lastImplied - 1) * 100).toFixed(1)}%)`,
        )
        continue
      }

      const priceScaled = BigInt(Math.round(price * 1e9))
      const feeScaled = BigInt(Math.round((1 - getFimsFeeRate()) * 1e9))
      const productUnits = delta.rawAmount
      const backingUnits = (productUnits * priceScaled * feeScaled) / 1_000_000_000_000_000_000n
      if (backingUnits <= 0n) continue

      if (backingUnits > (await redeemLiquidity(product))) continue

      // Every retryable check passed: atomically take the claim BEFORE the
      // irreversible on-chain payout. The row transitions
      // awaiting_liquidity → claimed exactly once, so a concurrent user
      // retry or keeper tick that also matched is skipped. (If this runner
      // then dies before or during custodialRedeem, the claim stays
      // 'claimed' — the same safe wedge as the HTTP path, unblocked by an
      // admin after checking the chain.)
      const transition = await db
        .update(wrappedClaims)
        .set({ state: 'claimed', updatedAt: new Date() })
        .where(
          and(
            eq(wrappedClaims.signature, claim.signature),
            eq(wrappedClaims.mint, claim.mint),
            eq(wrappedClaims.state, 'awaiting_liquidity'),
          ),
        )
        .returning({ mint: wrappedClaims.mint })
      if (!transition.length) continue

      // Same claim → 'minted' → 'recorded' progression as the live handler:
      // the ledger write replays idempotently if the process dies between.
      const custodialSignature = await custodialRedeem(product, solAddress(fetched.payer), productUnits, backingUnits)
      const mintedTransition = await db
        .update(wrappedClaims)
        .set({ custodialSignature, state: 'minted', updatedAt: new Date() })
        .where(
          and(
            eq(wrappedClaims.signature, claim.signature),
            eq(wrappedClaims.mint, claim.mint),
            eq(wrappedClaims.state, 'claimed'),
          ),
        )
        .returning({ mint: wrappedClaims.mint })
      if (!mintedTransition.length) {
        // Our own claim should still be 'claimed' — if it moved, something
        // else is driving this row: do NOT write the ledger entry.
        console.error(`queued redeem ${claim.signature}:${claim.mint} claim moved unexpectedly before ledger write`)
        continue
      }

      const productAmount = Number(productUnits) / 1e6
      const movement = price * productAmount
      const recorded = await runTransaction(async (tx) => {
        // Flip the claim to 'recorded' FIRST — the update is empty when
        // another path (e.g. a concurrent user retry) already recorded the
        // leg, and then the ledger insert must not happen: it would
        // duplicate the row (`transactions.signature` has no unique key).
        const flipped = await tx
          .update(wrappedClaims)
          .set({ state: 'recorded', updatedAt: new Date() })
          .where(
            and(
              eq(wrappedClaims.signature, claim.signature),
              eq(wrappedClaims.mint, claim.mint),
              eq(wrappedClaims.state, 'minted'),
            ),
          )
          .returning({ mint: wrappedClaims.mint })
        if (!flipped.length) return false
        await tx.insert(transactions).values({
          address: fetched.payer,
          amount: formatTokenUnits(-productUnits, 6),
          cost: movement,
          date: fetched.blockTime ?? new Date(),
          movement: -movement,
          signature: `${claim.signature}:${claim.mint}`,
          token: config.symbol,
          type: 'withdrawal',
          userId: member.id,
        })
        return true
      })
      // A lost recorded flip means a concurrent path owns the ledger write —
      // the claim is settled either way, but not by THIS runner.
      if (recorded) settled += 1
    } catch (error) {
      // One bad claim must not stall the queue — it retries next tick.
      console.error(`queued redeem ${claim.signature}:${claim.mint} failed`, error)
    }
  }
  return { attempted: claims.length, settled }
}
