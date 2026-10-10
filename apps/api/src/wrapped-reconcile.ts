// Queued-redeem settlement — runs inside the keeper pass. A member redeem
// that found no float is parked as 'awaiting_liquidity' in wrapped_claims
// (audit M-4): the member's product units already sit in custody, so the
// claim — not a fresh user request — is the authorization to burn+pay out.
// Each tick re-derives the leg from the on-chain deposit transaction at the
// CURRENT operator price and settles it when liquidity is available.

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
import type { Db } from './db/service.js'
import { getFimsFeeRate } from './fee-config.js'
import { PRICE_STALE_MS } from './routes/fims/helpers.js'
import { fetchDonationTransaction } from './solana-rpc.js'
import { formatTokenUnits } from './solana-util.js'
import { memberLinkedTo } from './tontine-reconcile.js'

const BATCH_LIMIT = 20

export async function processQueuedRedeems(db: Db): Promise<{ attempted: number; settled: number }> {
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
      if (!member) continue

      // Re-price at settlement time: the member locked product units at
      // deposit, the backing paid out tracks the current index (same fee).
      const tokenRow = (
        await db
          .select({ updatedAt: tokens.updatedAt, value: tokens.value })
          .from(tokens)
          .where(eq(tokens.symbol, config.symbol))
      )[0]
      const price = tokenRow?.value ?? 0
      if (price <= 0 || !tokenRow || Date.now() - tokenRow.updatedAt.getTime() > PRICE_STALE_MS) continue

      const priceScaled = BigInt(Math.round(price * 1e9))
      const feeScaled = BigInt(Math.round((1 - getFimsFeeRate()) * 1e9))
      const productUnits = delta.rawAmount
      const backingUnits = (productUnits * priceScaled * feeScaled) / 1_000_000_000_000_000_000n
      if (backingUnits <= 0n) continue

      if (backingUnits > (await redeemLiquidity(product))) continue

      // Same claim → 'minted' → 'recorded' progression as the live handler:
      // the ledger write replays idempotently if the process dies between.
      const custodialSignature = await custodialRedeem(product, solAddress(fetched.payer), productUnits, backingUnits)
      await db
        .update(wrappedClaims)
        .set({ custodialSignature, state: 'minted', updatedAt: new Date() })
        .where(and(eq(wrappedClaims.signature, claim.signature), eq(wrappedClaims.mint, claim.mint)))

      const productAmount = Number(productUnits) / 1e6
      const movement = price * productAmount
      await db.transaction(async (tx) => {
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
        await tx
          .update(wrappedClaims)
          .set({ state: 'recorded', updatedAt: new Date() })
          .where(and(eq(wrappedClaims.signature, claim.signature), eq(wrappedClaims.mint, claim.mint)))
      })
      settled += 1
    } catch (error) {
      // One bad claim must not stall the queue — it retries next tick.
      console.error(`queued redeem ${claim.signature}:${claim.mint} failed`, error)
    }
  }
  return { attempted: claims.length, settled }
}
