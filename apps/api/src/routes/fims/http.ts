import { HttpApiBuilder, HttpServerRequest } from '@effect/platform'
import { and, asc, desc, eq, ilike, type SQL } from 'drizzle-orm'
import { Effect, Layer, Option } from 'effect'
import { Api } from '../../api.ts'
import {
  addressBook,
  dashboardMetrics,
  historic,
  prices,
  tokens,
  transactions,
  userHistoric,
  users,
} from '../../db/schema.ts'
import { DatabaseError, DatabaseService, withDb } from '../../db/service.ts'
import {
  AuthForbidden,
  isAdminAddress,
  optionalWalletRequest,
  requireAdmin,
  requireOwnerOrAdmin,
  verifyWalletRequest,
} from '../../services/auth/service.ts'

const notFound = (what: string) => `not found: ${what}`
const insertFailed = () => new DatabaseError({ cause: 'insert returned no row' })

interface UserAccess {
  address: string
  isPublic: boolean
}

// A non-public user's data is only visible to that user (signed) or an admin.
// Any other signer is just a keypair — same visibility as anonymous.
const canSeeUser = (signer: Option.Option<string>, access: UserAccess) =>
  access.isPublic || Option.exists(signer, (s) => s === access.address || isAdminAddress(s))

const userAccessOfId = (userId: number) =>
  withDb((db) =>
    db.select({ address: users.address, isPublic: users.isPublic }).from(users).where(eq(users.id, userId)),
  ).pipe(
    Effect.flatMap((rows) => (rows[0] ? Effect.succeed<UserAccess>(rows[0]) : Effect.fail(notFound(`user ${userId}`)))),
  )

const ownerAddressOfUser = (userId: number) => userAccessOfId(userId).pipe(Effect.map((u) => u.address))

const ownerAddressOfAddressBookEntry = (id: number) =>
  withDb((db) =>
    db
      .select({ address: users.address })
      .from(addressBook)
      .leftJoin(users, eq(addressBook.userId, users.id))
      .where(eq(addressBook.id, id)),
  ).pipe(
    Effect.flatMap((rows) =>
      rows[0] ? Effect.succeed(rows[0].address ?? '') : Effect.fail(notFound(`address book entry ${id}`)),
    ),
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
    return (
      handlers
        .handle('users', ({ urlParams }) =>
          Effect.gen(function* () {
            const request = yield* HttpServerRequest.HttpServerRequest
            const signer = yield* optionalWalletRequest(request)
            const rows = yield* withDb((db) =>
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
            )
            return rows.filter((u) => canSeeUser(signer, u))
          }),
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
            // Privileged fields are admin-only: `address` reassignment would let a
            // member squat someone else's pubkey (member resolution picks the
            // lowest-id row → the squatter's address book is shown to the victim),
            // and `isPro` is a community trust badge.
            if (!isAdminAddress(signer) && (payload.address !== undefined || payload.isPro !== undefined)) {
              return yield* Effect.fail(new AuthForbidden({ address: signer }))
            }
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
            const rows = yield* withDb((db) =>
              db.delete(users).where(eq(users.id, path.id)).returning({ id: users.id }),
            )
            if (!rows[0]) return yield* Effect.fail(notFound(`user ${path.id}`))
            return `deleted user ${path.id}`
          }),
        )
        .handle('transactions', ({ urlParams }) =>
          Effect.gen(function* () {
            const request = yield* HttpServerRequest.HttpServerRequest
            const signer = yield* optionalWalletRequest(request)
            const filters: SQL[] = []
            if (urlParams.address) filters.push(eq(transactions.address, urlParams.address))
            if (urlParams.userId !== undefined) filters.push(eq(transactions.userId, urlParams.userId))
            const rows = yield* withDb((db) =>
              db
                .select({ ownerAddress: users.address, ownerPublic: users.isPublic, tx: transactions })
                .from(transactions)
                .leftJoin(users, eq(transactions.userId, users.id))
                .where(filters.length ? and(...filters) : undefined)
                .orderBy(desc(transactions.date)),
            )
            // Rows without an owner (userId null) are community-level data and stay public.
            return rows
              .filter(
                (r) =>
                  r.ownerAddress === null ||
                  canSeeUser(signer, { address: r.ownerAddress, isPublic: r.ownerPublic ?? false }),
              )
              .map((r) => r.tx)
          }),
        )
        // Community accounting data is written by the ETL only — member-writable
        // transactions would allow faking donations/deposits/withdrawals.
        .handle('createTransaction', ({ payload }) =>
          Effect.gen(function* () {
            const request = yield* HttpServerRequest.HttpServerRequest
            const signer = yield* verifyWalletRequest(request)
            yield* requireAdmin(signer)
            yield* userAccessOfId(payload.userId)
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
            yield* requireAdmin(signer)
            yield* ownerAddressOfTransaction(path.id)
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
            yield* requireAdmin(signer)
            yield* ownerAddressOfTransaction(path.id)
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
          Effect.gen(function* () {
            const request = yield* HttpServerRequest.HttpServerRequest
            const signer = yield* optionalWalletRequest(request)
            const rows = yield* withDb((db) =>
              db
                .select({ ownerAddress: users.address, ownerPublic: users.isPublic, point: userHistoric })
                .from(userHistoric)
                .innerJoin(users, eq(userHistoric.userId, users.id))
                .where(urlParams.userId !== undefined ? eq(userHistoric.userId, urlParams.userId) : undefined)
                .orderBy(asc(userHistoric.date)),
            )
            return rows
              .filter((r) => canSeeUser(signer, { address: r.ownerAddress, isPublic: r.ownerPublic }))
              .map((r) => r.point)
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
        .handle('addressBook', ({ urlParams }) =>
          Effect.gen(function* () {
            const request = yield* HttpServerRequest.HttpServerRequest
            const signer = yield* optionalWalletRequest(request)
            const rows = yield* withDb((db) =>
              db
                .select({ entry: addressBook, ownerAddress: users.address, ownerPublic: users.isPublic })
                .from(addressBook)
                .innerJoin(users, eq(addressBook.userId, users.id))
                .where(urlParams.userId !== undefined ? eq(addressBook.userId, urlParams.userId) : undefined)
                .orderBy(asc(addressBook.label)),
            )
            return rows
              .filter((r) => canSeeUser(signer, { address: r.ownerAddress, isPublic: r.ownerPublic }))
              .map((r) => r.entry)
          }),
        )
        .handle('createAddressBookEntry', ({ payload }) =>
          Effect.gen(function* () {
            const request = yield* HttpServerRequest.HttpServerRequest
            const signer = yield* verifyWalletRequest(request)
            const owner = yield* ownerAddressOfUser(payload.userId)
            yield* requireOwnerOrAdmin(signer, owner)
            const rows = yield* withDb((db) =>
              db
                .insert(addressBook)
                .values({ ...payload, type: payload.type ?? 'other' })
                .returning(),
            )
            const created = rows[0]
            if (!created) return yield* Effect.fail(insertFailed())
            return created
          }),
        )
        .handle('updateAddressBookEntry', ({ path, payload }) =>
          Effect.gen(function* () {
            const request = yield* HttpServerRequest.HttpServerRequest
            const signer = yield* verifyWalletRequest(request)
            const owner = yield* ownerAddressOfAddressBookEntry(path.id)
            yield* requireOwnerOrAdmin(signer, owner)
            const rows = yield* withDb((db) =>
              db.update(addressBook).set(payload).where(eq(addressBook.id, path.id)).returning(),
            )
            const updated = rows[0]
            if (!updated) return yield* Effect.fail(notFound(`address book entry ${path.id}`))
            return updated
          }),
        )
        .handle('deleteAddressBookEntry', ({ path }) =>
          Effect.gen(function* () {
            const request = yield* HttpServerRequest.HttpServerRequest
            const signer = yield* verifyWalletRequest(request)
            const owner = yield* ownerAddressOfAddressBookEntry(path.id)
            yield* requireOwnerOrAdmin(signer, owner)
            const rows = yield* withDb((db) =>
              db.delete(addressBook).where(eq(addressBook.id, path.id)).returning({ id: addressBook.id }),
            )
            if (!rows[0]) return yield* Effect.fail(notFound(`address book entry ${path.id}`))
            return `deleted address book entry ${path.id}`
          }),
        )
    )
  }),
).pipe(Layer.provide([DatabaseService.Default]))
