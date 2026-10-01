import { HttpApiBuilder, HttpServerRequest } from '@effect/platform'
import { and, asc, desc, eq, ilike, type SQL } from 'drizzle-orm'
import { Effect, Layer } from 'effect'
import { Api } from '../../api.ts'
import { dashboardMetrics, historic, prices, tokens, transactions, userHistoric, users } from '../../db/schema.ts'
import { DatabaseError, DatabaseService, withDb } from '../../db/service.ts'
import { requireOwnerOrAdmin, verifyWalletRequest } from '../../services/auth/service.ts'

const notFound = (what: string) => `not found: ${what}`
const insertFailed = () => new DatabaseError({ cause: 'insert returned no row' })

const ownerAddressOfUser = (userId: number) =>
  withDb((db) => db.select({ address: users.address }).from(users).where(eq(users.id, userId))).pipe(
    Effect.flatMap((rows) => (rows[0] ? Effect.succeed(rows[0].address) : Effect.fail(notFound(`user ${userId}`)))),
  )

// Transactions with userId = null are admin-only (empty owner never matches a signer)
const ownerAddressOfTransaction = (id: number) =>
  withDb((db) =>
    db
      .select({ address: users.address, txId: transactions.id })
      .from(transactions)
      .leftJoin(users, eq(transactions.userId, users.id))
      .where(eq(transactions.id, id)),
  ).pipe(
    Effect.flatMap((rows) =>
      rows[0] ? Effect.succeed(rows[0].address ?? '') : Effect.fail(notFound(`transaction ${id}`)),
    ),
  )

export const HttpFimsLive = HttpApiBuilder.group(Api, 'Fims', (handlers) =>
  Effect.gen(function* () {
    return handlers
      .handle('users', ({ urlParams }) =>
        withDb((db) =>
          db
            .select()
            .from(users)
            .where(
              and(
                urlParams.name ? ilike(users.name, urlParams.name) : undefined,
                urlParams.address ? eq(users.address, urlParams.address) : undefined,
              ),
            )
            .orderBy(asc(users.id)),
        ),
      )
      .handle('createUser', ({ payload }) =>
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest
          const signer = yield* verifyWalletRequest(request)
          yield* requireOwnerOrAdmin(signer, payload.address)
          const rows = yield* withDb((db) => db.insert(users).values(payload).returning())
          const created = rows[0]
          if (!created) return yield* Effect.fail(insertFailed())
          return created
        }),
      )
      .handle('updateUser', ({ path, payload }) =>
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest
          const signer = yield* verifyWalletRequest(request)
          const owner = yield* ownerAddressOfUser(path.id)
          yield* requireOwnerOrAdmin(signer, owner)
          const rows = yield* withDb((db) =>
            db
              .update(users)
              .set({ ...payload, updatedAt: new Date() })
              .where(eq(users.id, path.id))
              .returning(),
          )
          const updated = rows[0]
          if (!updated) return yield* Effect.fail(notFound(`user ${path.id}`))
          return updated
        }),
      )
      .handle('deleteUser', ({ path }) =>
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest
          const signer = yield* verifyWalletRequest(request)
          const owner = yield* ownerAddressOfUser(path.id)
          yield* requireOwnerOrAdmin(signer, owner)
          const rows = yield* withDb((db) => db.delete(users).where(eq(users.id, path.id)).returning({ id: users.id }))
          if (!rows[0]) return yield* Effect.fail(notFound(`user ${path.id}`))
          return `deleted user ${path.id}`
        }),
      )
      .handle('transactions', ({ urlParams }) =>
        withDb((db) => {
          const filters: SQL[] = []
          if (urlParams.address) filters.push(eq(transactions.address, urlParams.address))
          if (urlParams.userId !== undefined) filters.push(eq(transactions.userId, urlParams.userId))
          const q = db.select().from(transactions).orderBy(desc(transactions.date)).$dynamic()
          return filters.length ? q.where(and(...filters)) : q
        }),
      )
      .handle('createTransaction', ({ payload }) =>
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest
          const signer = yield* verifyWalletRequest(request)
          const owner = yield* ownerAddressOfUser(payload.userId)
          yield* requireOwnerOrAdmin(signer, owner)
          const rows = yield* withDb((db) => db.insert(transactions).values(payload).returning())
          const created = rows[0]
          if (!created) return yield* Effect.fail(insertFailed())
          return created
        }),
      )
      .handle('updateTransaction', ({ path, payload }) =>
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest
          const signer = yield* verifyWalletRequest(request)
          const owner = yield* ownerAddressOfTransaction(path.id)
          yield* requireOwnerOrAdmin(signer, owner)
          const rows = yield* withDb((db) =>
            db.update(transactions).set(payload).where(eq(transactions.id, path.id)).returning(),
          )
          const updated = rows[0]
          if (!updated) return yield* Effect.fail(notFound(`transaction ${path.id}`))
          return updated
        }),
      )
      .handle('deleteTransaction', ({ path }) =>
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest
          const signer = yield* verifyWalletRequest(request)
          const owner = yield* ownerAddressOfTransaction(path.id)
          yield* requireOwnerOrAdmin(signer, owner)
          const rows = yield* withDb((db) =>
            db.delete(transactions).where(eq(transactions.id, path.id)).returning({ id: transactions.id }),
          )
          if (!rows[0]) return yield* Effect.fail(notFound(`transaction ${path.id}`))
          return `deleted transaction ${path.id}`
        }),
      )
      .handle('tokens', () => withDb((db) => db.select().from(tokens).orderBy(asc(tokens.symbol))))
      .handle('historic', () => withDb((db) => db.select().from(historic).orderBy(asc(historic.date))))
      .handle('userHistoric', ({ urlParams }) =>
        withDb((db) => {
          const q = db.select().from(userHistoric).orderBy(asc(userHistoric.date)).$dynamic()
          return urlParams.userId !== undefined ? q.where(eq(userHistoric.userId, urlParams.userId)) : q
        }),
      )
      .handle('prices', ({ urlParams }) =>
        withDb((db) => {
          const q = db.select().from(prices).orderBy(asc(prices.date)).$dynamic()
          return urlParams.token ? q.where(eq(prices.token, urlParams.token)) : q
        }),
      )
      .handle('dashboard', () =>
        withDb((db) => db.select().from(dashboardMetrics).orderBy(asc(dashboardMetrics.label))),
      )
  }),
).pipe(Layer.provide([DatabaseService.Default]))
