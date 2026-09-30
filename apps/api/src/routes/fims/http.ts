import { HttpApiBuilder } from '@effect/platform'
import { and, asc, desc, eq, ilike, type SQL } from 'drizzle-orm'
import { Effect, Layer } from 'effect'
import { Api } from '../../api.ts'
import { dashboardMetrics, historic, prices, tokens, transactions, userHistoric, users } from '../../db/schema.ts'
import { DatabaseError, DatabaseService, withDb } from '../../db/service.ts'

const notFound = (what: string) => `not found: ${what}`
const insertFailed = () => new DatabaseError({ cause: 'insert returned no row' })

export const HttpFimsLive = HttpApiBuilder.group(Api, 'Fims', (handlers) =>
  Effect.gen(function* () {
    return handlers
      .handle('users', ({ urlParams }) =>
        withDb((db) =>
          urlParams.name
            ? db.select().from(users).where(ilike(users.name, urlParams.name))
            : db.select().from(users).orderBy(asc(users.id)),
        ),
      )
      .handle('createUser', ({ payload }) =>
        withDb((db) => db.insert(users).values(payload).returning()).pipe(
          Effect.flatMap((rows) => (rows[0] ? Effect.succeed(rows[0]) : Effect.fail(insertFailed()))),
        ),
      )
      .handle('updateUser', ({ path, payload }) =>
        withDb((db) => db.update(users).set(payload).where(eq(users.id, path.id)).returning()).pipe(
          Effect.flatMap((rows) => (rows[0] ? Effect.succeed(rows[0]) : Effect.fail(notFound(`user ${path.id}`)))),
        ),
      )
      .handle('deleteUser', ({ path }) =>
        withDb((db) => db.delete(users).where(eq(users.id, path.id)).returning({ id: users.id })).pipe(
          Effect.flatMap((rows) =>
            rows[0] ? Effect.succeed(`deleted user ${path.id}`) : Effect.fail(notFound(`user ${path.id}`)),
          ),
        ),
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
        withDb((db) => db.insert(transactions).values(payload).returning()).pipe(
          Effect.flatMap((rows) => (rows[0] ? Effect.succeed(rows[0]) : Effect.fail(insertFailed()))),
        ),
      )
      .handle('updateTransaction', ({ path, payload }) =>
        withDb((db) => db.update(transactions).set(payload).where(eq(transactions.id, path.id)).returning()).pipe(
          Effect.flatMap((rows) =>
            rows[0] ? Effect.succeed(rows[0]) : Effect.fail(notFound(`transaction ${path.id}`)),
          ),
        ),
      )
      .handle('deleteTransaction', ({ path }) =>
        withDb((db) =>
          db.delete(transactions).where(eq(transactions.id, path.id)).returning({ id: transactions.id }),
        ).pipe(
          Effect.flatMap((rows) =>
            rows[0]
              ? Effect.succeed(`deleted transaction ${path.id}`)
              : Effect.fail(notFound(`transaction ${path.id}`)),
          ),
        ),
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
