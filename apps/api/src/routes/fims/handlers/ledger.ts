import { HttpServerRequest } from '@effect/platform'
import { and, asc, desc, eq, inArray, isNull, or, type SQL } from 'drizzle-orm'
import { Effect, Option, type Schema } from 'effect'
import {
  addressBook,
  dashboardMetrics,
  historic,
  prices,
  tokens,
  transactions,
  userHistoric,
  users,
} from '../../../db/schema.js'
import { withDb } from '../../../db/service.js'
import {
  isAdminAddress,
  optionalWalletRequest,
  requireAdmin,
  verifyWalletRequest,
} from '../../../services/auth/service.js'
import { BadRequest, type CreateTransactionBody, type UpdateTransactionBody } from '../api.js'
import {
  addressLinkedToUser,
  auditAdmin,
  deriveTransactionType,
  insertFailed,
  notFound,
  ownerAddressOfTransaction,
  pageParams,
  userAccessOfId,
  visibilityFilter,
} from '../helpers.js'

export const handleTransactions = ({
  urlParams,
}: {
  urlParams: {
    address?: string | undefined
    limit?: number | undefined
    offset?: number | undefined
    userId?: number | undefined
  }
}) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest
    const signer = yield* optionalWalletRequest(request)
    const { limit, offset } = pageParams(urlParams)
    const filters: SQL[] = []
    if (urlParams.address) filters.push(eq(transactions.address, urlParams.address))
    if (urlParams.userId !== undefined) filters.push(eq(transactions.userId, urlParams.userId))
    // Rows without an owner (userId null → leftJoin yields null users.id)
    // are community-level data and stay public.
    const privacy = Option.match(signer, {
      onNone: () => or(isNull(users.id), eq(users.isPublic, true)),
      onSome: (s) =>
        isAdminAddress(s) ? undefined : or(isNull(users.id), eq(users.isPublic, true), addressLinkedToUser(s)),
    })
    if (privacy) filters.push(privacy)
    const rows = yield* withDb((db) =>
      db
        .select({ tx: transactions })
        .from(transactions)
        .leftJoin(users, eq(transactions.userId, users.id))
        .where(filters.length ? and(...filters) : undefined)
        .orderBy(desc(transactions.date), desc(transactions.id))
        .limit(limit)
        .offset(offset),
    )
    return rows.map((r) => r.tx)
  })

export const handleCreateTransaction = ({ payload }: { payload: Schema.Schema.Type<typeof CreateTransactionBody> }) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest
    const signer = yield* verifyWalletRequest(request)
    yield* requireAdmin(signer)
    yield* userAccessOfId(payload.userId)
    // Exchange tagging is scoped to the transaction owner's own
    // address book: an entry in ANOTHER member's book must not
    // reclassify this member's flows (that would let anyone skew
    // the community accounting by tagging shared exchange wallets).
    const cexRows = yield* withDb((db) =>
      db
        .select({ id: addressBook.id })
        .from(addressBook)
        .where(
          and(
            eq(addressBook.address, payload.address),
            eq(addressBook.userId, payload.userId),
            inArray(addressBook.type, ['binance', 'coinbase', 'nexo']),
          ),
        ),
    )
    const type = payload.type ?? deriveTransactionType(payload.movement, payload.cost ?? 0, cexRows.length > 0)
    // A donation without a target is ambiguous bookkeeping: 'tontine'
    // means the gifted token lands in the shared pot's wallet (the
    // account contents must equal the matching transactions exactly)

    // anything else ('association', …) is a gift to an external
    // organism. Reject rather than guess.
    if (type === 'donation' && !payload.donationTarget)
      return yield* Effect.fail(new BadRequest({ reason: 'donationTarget is required for a donation' }))
    // donationAmount is an extra gift outflow on top of `amount`
    // (e.g. a withdrawal also carrying its tontine share): it needs a
    // target, stays positive, and only makes sense on outflow rows.
    if (payload.donationAmount != null) {
      if (type === 'donation' || type === 'payment' || type === 'tontine')
        return yield* Effect.fail(new BadRequest({ reason: `donationAmount is redundant on a ${type} row` }))
      if (!payload.donationTarget)
        return yield* Effect.fail(new BadRequest({ reason: 'donationTarget is required when donationAmount is set' }))
      if (payload.donationAmount <= 0 || payload.amount == null || payload.amount >= 0)
        return yield* Effect.fail(
          new BadRequest({ reason: 'donationAmount requires a positive value on an outflow (amount < 0)' }),
        )
    }
    const rows = yield* withDb((db) =>
      db
        .insert(transactions)
        .values({ ...payload, type })
        .returning(),
    )
    const created = rows[0]
    if (!created) return yield* Effect.fail(insertFailed())
    yield* auditAdmin(signer, 'create_transaction', String(created.id), payload)
    return created
  })

export const handleUpdateTransaction = ({
  path,
  payload,
}: {
  path: { id: number }
  payload: Schema.Schema.Type<typeof UpdateTransactionBody>
}) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest
    const signer = yield* verifyWalletRequest(request)
    yield* requireAdmin(signer)
    yield* ownerAddressOfTransaction(path.id)
    // Same embedded-gift rule as createTransaction, checked against the
    // merged row (existing + patch) so a partial update cannot leave an
    // incoherent donation_amount/donation_target pair.
    if (payload.donationAmount !== undefined || payload.donationTarget !== undefined) {
      const existing = yield* withDb((db) => db.select().from(transactions).where(eq(transactions.id, path.id)))
      const merged = { ...existing[0], ...payload }
      if (merged.donationAmount != null) {
        if (merged.type === 'donation' || merged.type === 'payment' || merged.type === 'tontine')
          return yield* Effect.fail(new BadRequest({ reason: `donationAmount is redundant on a ${merged.type} row` }))
        if (!merged.donationTarget)
          return yield* Effect.fail(new BadRequest({ reason: 'donationTarget is required when donationAmount is set' }))
        if (merged.donationAmount <= 0 || merged.amount == null || merged.amount >= 0)
          return yield* Effect.fail(
            new BadRequest({ reason: 'donationAmount requires a positive value on an outflow (amount < 0)' }),
          )
      }
    }
    const rows = yield* withDb((db) =>
      db.update(transactions).set(payload).where(eq(transactions.id, path.id)).returning(),
    )
    const updated = rows[0]
    if (!updated) return yield* Effect.fail(notFound(`transaction ${path.id}`))
    yield* auditAdmin(signer, 'update_transaction', String(path.id), payload)
    return updated
  })

export const handleDeleteTransaction = ({ path }: { path: { id: number } }) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest
    const signer = yield* verifyWalletRequest(request)
    yield* requireAdmin(signer)
    yield* ownerAddressOfTransaction(path.id)
    const rows = yield* withDb((db) =>
      db.delete(transactions).where(eq(transactions.id, path.id)).returning({ id: transactions.id }),
    )
    if (!rows[0]) return yield* Effect.fail(notFound(`transaction ${path.id}`))
    yield* auditAdmin(signer, 'delete_transaction', String(path.id))
    return `deleted transaction ${path.id}`
  })

export const handleTokens = ({
  urlParams,
}: {
  urlParams: { limit?: number | undefined; offset?: number | undefined }
}) => {
  const { limit, offset } = pageParams(urlParams)
  return withDb((db) => db.select().from(tokens).orderBy(asc(tokens.symbol)).limit(limit).offset(offset))
}

export const handleHistoric = ({
  urlParams,
}: {
  urlParams: { limit?: number | undefined; offset?: number | undefined }
}) => {
  const { limit, offset } = pageParams(urlParams)
  return withDb((db) => db.select().from(historic).orderBy(asc(historic.date)).limit(limit).offset(offset))
}

export const handleUserHistoric = ({
  urlParams,
}: {
  urlParams: { limit?: number | undefined; offset?: number | undefined; userId?: number | undefined }
}) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest
    const signer = yield* optionalWalletRequest(request)
    const { limit, offset } = pageParams(urlParams)
    const filters: SQL[] = []
    if (urlParams.userId !== undefined) filters.push(eq(userHistoric.userId, urlParams.userId))
    const privacy = visibilityFilter(signer)
    if (privacy) filters.push(privacy)
    const rows = yield* withDb((db) =>
      db
        .select({ point: userHistoric })
        .from(userHistoric)
        .innerJoin(users, eq(userHistoric.userId, users.id))
        .where(filters.length ? and(...filters) : undefined)
        .orderBy(asc(userHistoric.date), asc(userHistoric.userId))
        .limit(limit)
        .offset(offset),
    )
    return rows.map((r) => r.point)
  })

export const handlePrices = ({
  urlParams,
}: {
  urlParams: { limit?: number | undefined; offset?: number | undefined; token?: string | undefined }
}) => {
  const { limit, offset } = pageParams(urlParams)
  return withDb((db) =>
    db
      .select()
      .from(prices)
      .where(urlParams.token ? eq(prices.token, urlParams.token) : undefined)
      .orderBy(asc(prices.date), asc(prices.token))
      .limit(limit)
      .offset(offset),
  )
}

export const handleDashboard = () =>
  withDb((db) => db.select().from(dashboardMetrics).orderBy(asc(dashboardMetrics.label)))
