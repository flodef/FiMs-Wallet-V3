import { neon, Pool } from '@neondatabase/serverless'
import { drizzle, type NeonHttpDatabase } from 'drizzle-orm/neon-http'
import { drizzle as drizzleWs, type NeonDatabase } from 'drizzle-orm/neon-serverless'
import { Effect, Schema } from 'effect'
import * as schema from './schema.js'

export type Db = NeonHttpDatabase<typeof schema>
export type TxDb = NeonDatabase<typeof schema>

export class DatabaseNotConfigured extends Schema.TaggedError<DatabaseNotConfigured>()('DatabaseNotConfigured', {}) {}

export class DatabaseError extends Schema.TaggedError<DatabaseError>()('DatabaseError', {
  cause: Schema.Defect,
}) {}

// DATABASE_URL is exposed via process.env thanks to the nodejs_compat flag
// (secrets: `wrangler secret put DATABASE_URL`, local: .dev.vars)
export class DatabaseService extends Effect.Service<DatabaseService>()('Database', {
  effect: Effect.gen(function* () {
    const url = process.env['DATABASE_URL']
    if (!url) {
      return yield* Effect.fail(new DatabaseNotConfigured())
    }
    return { db: drizzle(neon(url), { schema }) }
  }),
}) {}

export const withDb = <A>(run: (db: Db) => Promise<A>) =>
  Effect.gen(function* () {
    const { db } = yield* DatabaseService
    // Schema.Defect fields are never serialized to the client — the response
    // is a bare { _tag: 'DatabaseError' } — so the real cause is logged here
    // instead of travelling in the error.
    return yield* Effect.tryPromise({
      catch: (cause) => new DatabaseError({ cause }),
      try: () => run(db),
    }).pipe(Effect.tapError((error) => Effect.logError('database error', error.cause)))
  })

// Interactive transactions need a session, which the stateless neon-http
// driver cannot do — `db.transaction` on the `Db` handle throws
// "No transactions support in neon-http driver". A Pool (WebSocket) is
// opened for the duration of the request and always closed. The callback
// must return plain values — thrown errors abort the transaction. Plain
// (non-Effect) callers like the keeper use this directly; HTTP handlers go
// through `withTransaction`, which signals expected failures with a
// discriminated result instead of throwing.
export const runTransaction = async <A>(run: (db: TxDb) => Promise<A>): Promise<A> => {
  const url = process.env['DATABASE_URL']
  if (!url) throw new DatabaseNotConfigured()
  const pool = new Pool({ connectionString: url })
  try {
    return await drizzleWs(pool, { schema }).transaction(run)
  } finally {
    await pool.end()
  }
}

export const withTransaction = <A>(run: (db: TxDb) => Promise<A>) =>
  Effect.gen(function* () {
    // Keep the dedicated tag on the error channel — endpoints map it to
    // 503; a DatabaseError cause would surface as 500.
    if (!process.env['DATABASE_URL']) {
      return yield* Effect.fail(new DatabaseNotConfigured())
    }
    return yield* Effect.tryPromise({
      catch: (cause) => new DatabaseError({ cause }),
      try: () => runTransaction(run),
    }).pipe(Effect.tapError((error) => Effect.logError('database error', error.cause)))
  })
