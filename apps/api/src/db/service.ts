import { neon } from '@neondatabase/serverless'
import { drizzle, type NeonHttpDatabase } from 'drizzle-orm/neon-http'
import { Effect, Schema } from 'effect'
import * as schema from './schema.ts'

export type Db = NeonHttpDatabase<typeof schema>

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
    return yield* Effect.tryPromise({
      catch: (cause) => new DatabaseError({ cause }),
      try: () => run(db),
    })
  })
