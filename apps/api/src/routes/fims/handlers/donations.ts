import { HttpServerRequest } from '@effect/platform'
import { eq } from 'drizzle-orm'
import { Effect, type Schema } from 'effect'
import { tokens, transactions, usedSignatures, users } from '../../../db/schema.js'
import { withDb, withTransaction } from '../../../db/service.js'
import { FIMS_TONTINE_ADDRESS } from '../../../fims-constants.js'
import { requireNotDemo, verifyWalletRequest } from '../../../services/auth/service.js'
import { fetchDonationTransaction } from '../../../solana-rpc.js'
import { formatTokenUnits } from '../../../solana-util.js'
import { BadRequest, type RecordDonationBody } from '../api.js'
import { addressLinkedToUser, insertFailed, requireMember } from '../helpers.js'

export const handleRecordDonation = ({ payload }: { payload: Schema.Schema.Type<typeof RecordDonationBody> }) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest
    const signer = yield* verifyWalletRequest(request)
    yield* requireNotDemo(signer)
    const member = yield* requireMember(signer)
    // Idempotent: a retry of the same signature returns what was
    // already recorded instead of double-counting the donation.
    const existing = yield* withDb((db) =>
      db.select().from(transactions).where(eq(transactions.signature, payload.signature)),
    )
    if (existing.length) return existing

    const fetched = yield* Effect.tryPromise({
      catch: () => new BadRequest({ reason: 'cannot fetch transaction from the RPC' }),
      try: () => fetchDonationTransaction(payload.signature, FIMS_TONTINE_ADDRESS),
    })
    if (!fetched)
      return yield* Effect.fail(new BadRequest({ reason: 'transaction not found, failed, or not finalized' }))
    // Only deltas the fee payer actually FUNDED can be attributed to them —
    // a third party may credit the pot inside the same transaction without
    // making it the payer's gift (audit H-3).
    const deltas = fetched.deltas.filter((delta) => delta.payerSourced)
    if (!deltas.length)
      return yield* Effect.fail(new BadRequest({ reason: 'transaction did not credit the tontine from your wallet' }))
    // The fee payer must belong to the signer: recording someone
    // else's gift under your own name would inflate your vote weight
    // and erase your debt for free.
    const payerRows = yield* withDb((db) =>
      db.select({ id: users.id }).from(users).where(addressLinkedToUser(fetched.payer)),
    )
    if (payerRows[0]?.id !== member.id)
      return yield* Effect.fail(new BadRequest({ reason: 'donation sender is not linked to your member account' }))

    const tokenRows = yield* withDb((db) => db.select().from(tokens))
    const priceOf = (symbol: string) => tokenRows.find((t) => t.symbol === symbol)?.value ?? null
    const symbolOf = (mint: string) =>
      mint === 'SOL' ? 'SOL' : (tokenRows.find((t) => t.address === mint)?.symbol ?? null)

    // Claim the signature inside a transaction: two concurrent
    // recordings serialize on the PK, so only one writes the rows —
    // the other returns them. The claim rolls back with any failure,
    // so a crashed attempt stays retryable.
    const rows = yield* withTransaction(async (tx) => {
      const claim = await tx
        .insert(usedSignatures)
        .values({ signature: `donation:${payload.signature}` })
        .onConflictDoNothing()
        .returning()
      if (!claim.length) return null
      const committed = await tx.select().from(transactions).where(eq(transactions.signature, payload.signature))
      if (committed.length) return committed
      return tx
        .insert(transactions)
        .values(
          deltas.map((delta) => {
            const symbol = symbolOf(delta.mint)
            const movement = symbol ? (priceOf(symbol) ?? 0) * delta.amount : 0
            return {
              address: fetched.payer,
              amount: formatTokenUnits(delta.rawAmount, delta.decimals),
              cost: movement,
              date: fetched.blockTime ?? new Date(),
              donationTarget: 'tontine',
              movement,
              signature: payload.signature,
              token: symbol,
              type: 'donation' as const,
              userId: member.id,
            }
          }),
        )
        .returning()
    })
    if (rows === null) {
      // Someone else recorded it — serve what they wrote.
      const committed = yield* withDb((db) =>
        db.select().from(transactions).where(eq(transactions.signature, payload.signature)),
      )
      if (committed.length) return committed
      return yield* Effect.fail(new BadRequest({ reason: 'donation recording in flight — retry in a few seconds' }))
    }
    if (!rows.length) return yield* Effect.fail(insertFailed())
    return rows
  })
