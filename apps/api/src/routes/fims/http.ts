import { HttpApiBuilder, HttpServerRequest } from '@effect/platform'
import { and, asc, desc, eq, ilike, inArray, isNull, or, type SQL, sql } from 'drizzle-orm'
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
  voteBallots,
  voteOptions,
  votes,
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
import { BadRequest, RateLimited } from './api.ts'

const notFound = (what: string) => `not found: ${what}`
const insertFailed = () => new DatabaseError({ cause: 'insert returned no row' })

// All list reads are bounded: a single unbounded query would scan a whole
// table (Neon cost) and produce oversized responses.
const DEFAULT_PAGE_SIZE = 500
const MAX_PAGE_SIZE = 2000

const pageParams = ({ limit, offset }: { limit?: number | undefined; offset?: number | undefined }) => ({
  limit: Math.min(Math.max(1, Math.floor(limit ?? DEFAULT_PAGE_SIZE)), MAX_PAGE_SIZE),
  offset: Math.max(0, Math.floor(offset ?? 0)),
})

interface UserAccess {
  address: string
  isPublic: boolean
}

// A non-public user's data is only visible to that user (signed) or an admin.
// Any other signer is just a keypair — same visibility as anonymous.
// The filter lives in the WHERE clause: filtering after LIMIT/OFFSET would
// silently truncate pages.
const visibilityFilter = (signer: Option.Option<string>) =>
  Option.match(signer, {
    onNone: () => eq(users.isPublic, true),
    onSome: (s) => (isAdminAddress(s) ? undefined : or(eq(users.isPublic, true), eq(users.address, s))),
  })

const userAccessOfId = (userId: number) =>
  withDb((db) =>
    db.select({ address: users.address, isPublic: users.isPublic }).from(users).where(eq(users.id, userId)),
  ).pipe(
    Effect.flatMap((rows) => (rows[0] ? Effect.succeed<UserAccess>(rows[0]) : Effect.fail(notFound(`user ${userId}`)))),
  )

const ownerAddressOfUser = (userId: number) => userAccessOfId(userId).pipe(Effect.map((u) => u.address))

const PROFILE_EDIT_COOLDOWN_MS = 24 * 60 * 60 * 1000

// Members may edit their own profile (name/privacy) at most once a day — the
// name is displayed publicly and flipping it constantly would confuse the
// community views. Admin edits bypass the cooldown entirely.
const memberProfileEditAllowed = (userId: number) =>
  withDb((db) => db.select({ profileUpdatedAt: users.profileUpdatedAt }).from(users).where(eq(users.id, userId))).pipe(
    Effect.flatMap((rows) => {
      const last = rows[0]?.profileUpdatedAt
      return last && Date.now() - last.getTime() < PROFILE_EDIT_COOLDOWN_MS
        ? Effect.fail(new RateLimited({ reason: `profile already edited ${last.toISOString()}` }))
        : Effect.void
    }),
  )

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

// Vote weight: a tontine ballot weighs the member's total tontine
// contributions; an investment ballot weighs the member's latest invested
// amount (same weighting rule as the legacy spreadsheet).
const loadVoteWeights = Effect.gen(function* () {
  const investedRows = (yield* withDb((db) =>
    db.execute(
      sql`SELECT DISTINCT ON (user_id) user_id, invested::float AS invested FROM user_historic ORDER BY user_id, date DESC`,
    ),
  )).rows as { invested: number; user_id: number }[]
  const tontineRows = (yield* withDb((db) =>
    db.execute(
      sql`SELECT user_id, SUM(movement)::float AS weight FROM transactions WHERE type = 'tontine' AND movement > 0 GROUP BY user_id`,
    ),
  )).rows as { user_id: number; weight: number }[]
  const invested = new Map(investedRows.map((r) => [r.user_id, Number(r.invested)]))
  const tontine = new Map(tontineRows.map((r) => [r.user_id, Number(r.weight)]))
  return { invested, tontine }
})

const loadVotesWithResults = (signer: Option.Option<string>) =>
  Effect.gen(function* () {
    const [voteRows, optionRows, ballotRows, weights, signerUser] = yield* Effect.all([
      withDb((db) => db.select().from(votes).orderBy(desc(votes.createdAt))),
      withDb((db) => db.select().from(voteOptions).orderBy(asc(voteOptions.sortOrder), asc(voteOptions.id))),
      withDb((db) => db.select().from(voteBallots)),
      loadVoteWeights,
      Option.match(signer, {
        onNone: () => Effect.succeed(null),
        onSome: (address) =>
          withDb((db) => db.select({ id: users.id }).from(users).where(eq(users.address, address))).pipe(
            Effect.map((rows) => rows[0] ?? null),
          ),
      }),
    ])
    const signerUserId = signerUser?.id ?? null
    return voteRows.map((vote) => {
      const weightOf = (userId: number) =>
        (vote.kind === 'tontine' ? weights.tontine : weights.invested).get(userId) ?? 0
      const ballots = ballotRows.filter((b) => b.voteId === vote.id)
      const options = optionRows
        .filter((o) => o.voteId === vote.id)
        .map((o) => {
          const optionBallots = ballots.filter((b) => b.optionId === o.id)
          return {
            ballots: optionBallots.length,
            id: o.id,
            label: o.label,
            sortOrder: o.sortOrder,
            weight: optionBallots.reduce((sum, b) => sum + weightOf(b.userId), 0),
          }
        })
      return {
        ...vote,
        myOptionId: ballots.find((b) => b.userId === signerUserId)?.optionId ?? null,
        options,
        totalWeight: options.reduce((sum, o) => sum + o.weight, 0),
      }
    })
  })

export const HttpFimsLive = HttpApiBuilder.group(Api, 'Fims', (handlers) =>
  Effect.gen(function* () {
    return (
      handlers
        .handle('users', ({ urlParams }) =>
          Effect.gen(function* () {
            const request = yield* HttpServerRequest.HttpServerRequest
            const signer = yield* optionalWalletRequest(request)
            const { limit, offset } = pageParams(urlParams)
            return yield* withDb((db) =>
              db
                .select()
                .from(users)
                .where(
                  and(
                    urlParams.name ? ilike(users.name, urlParams.name) : undefined,
                    urlParams.address ? eq(users.address, urlParams.address) : undefined,
                    visibilityFilter(signer),
                  ),
                )
                .orderBy(asc(users.id))
                .limit(limit)
                .offset(offset),
            )
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
            const isAdmin = isAdminAddress(signer)
            if (!isAdmin && (payload.address !== undefined || payload.isPro !== undefined)) {
              return yield* Effect.fail(new AuthForbidden({ address: signer }))
            }
            // The daily edit allowance covers identity fields only — the
            // rebalance target is a preference and stays freely editable.
            const touchesIdentity = payload.name !== undefined || payload.isPublic !== undefined
            if (!isAdmin && touchesIdentity) {
              yield* memberProfileEditAllowed(path.id)
            }
            if (!isAdmin) {
              if (payload.name !== undefined) {
                const taken = yield* withDb((db) =>
                  db
                    .select({ id: users.id })
                    .from(users)
                    .where(and(eq(users.name, payload.name ?? ''), sql`${users.id} <> ${path.id}`)),
                )
                if (taken.length)
                  return yield* Effect.fail(new BadRequest({ reason: `name already taken: ${payload.name}` }))
              }
            }
            const rows = yield* withDb((db) =>
              db
                .update(users)
                .set({
                  ...payload,
                  // Only member self-edits consume the daily edit allowance.
                  ...(isAdmin || !touchesIdentity ? {} : { profileUpdatedAt: new Date() }),
                  updatedAt: new Date(),
                })
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
            const { limit, offset } = pageParams(urlParams)
            const filters: SQL[] = []
            if (urlParams.address) filters.push(eq(transactions.address, urlParams.address))
            if (urlParams.userId !== undefined) filters.push(eq(transactions.userId, urlParams.userId))
            // Rows without an owner (userId null → leftJoin yields null users.id)
            // are community-level data and stay public.
            const privacy = Option.match(signer, {
              onNone: () => or(isNull(users.id), eq(users.isPublic, true)),
              onSome: (s) =>
                isAdminAddress(s) ? undefined : or(isNull(users.id), eq(users.isPublic, true), eq(users.address, s)),
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
        .handle('tokens', ({ urlParams }) => {
          const { limit, offset } = pageParams(urlParams)
          return withDb((db) => db.select().from(tokens).orderBy(asc(tokens.symbol)).limit(limit).offset(offset))
        })
        .handle('historic', ({ urlParams }) => {
          const { limit, offset } = pageParams(urlParams)
          return withDb((db) => db.select().from(historic).orderBy(asc(historic.date)).limit(limit).offset(offset))
        })
        .handle('userHistoric', ({ urlParams }) =>
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
          }),
        )
        .handle('prices', ({ urlParams }) => {
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
        })
        .handle('dashboard', () =>
          withDb((db) => db.select().from(dashboardMetrics).orderBy(asc(dashboardMetrics.label))),
        )
        .handle('addressBook', ({ urlParams }) =>
          Effect.gen(function* () {
            const request = yield* HttpServerRequest.HttpServerRequest
            const signer = yield* optionalWalletRequest(request)
            const { limit, offset } = pageParams(urlParams)
            const filters: SQL[] = []
            if (urlParams.userId !== undefined) filters.push(eq(addressBook.userId, urlParams.userId))
            const privacy = visibilityFilter(signer)
            if (privacy) filters.push(privacy)
            const rows = yield* withDb((db) =>
              db
                .select({ entry: addressBook })
                .from(addressBook)
                .innerJoin(users, eq(addressBook.userId, users.id))
                .where(filters.length ? and(...filters) : undefined)
                .orderBy(asc(addressBook.label), asc(addressBook.id))
                .limit(limit)
                .offset(offset),
            )
            return rows.map((r) => r.entry)
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
        // Member-initiated rebalance: moves EUR value between two of the
        // member's tokens. Units are priced server-side so the client cannot
        // forge amounts; the pair nets to zero (no fake deposit/donation).
        .handle('convertPosition', ({ payload }) =>
          Effect.gen(function* () {
            const request = yield* HttpServerRequest.HttpServerRequest
            const signer = yield* verifyWalletRequest(request)
            const memberRows = yield* withDb((db) =>
              db.select({ id: users.id }).from(users).where(eq(users.address, signer)),
            )
            const member = memberRows[0]
            if (!member) return yield* Effect.fail(new BadRequest({ reason: 'signer is not a FiMs member' }))
            if (payload.fromToken === payload.toToken)
              return yield* Effect.fail(new BadRequest({ reason: 'source and destination tokens must differ' }))
            const priceRows = yield* withDb((db) =>
              db
                .select({ symbol: tokens.symbol, value: tokens.value })
                .from(tokens)
                .where(inArray(tokens.symbol, [payload.fromToken, payload.toToken])),
            )
            const priceOf = new Map(priceRows.map((r) => [r.symbol, r.value]))
            const fromPrice = priceOf.get(payload.fromToken)
            const toPrice = priceOf.get(payload.toToken)
            if (fromPrice == null || fromPrice <= 0 || toPrice == null || toPrice <= 0)
              return yield* Effect.fail(new BadRequest({ reason: 'unknown or unpriced token' }))
            const unitRows = (yield* withDb((db) =>
              db.execute(
                sql`SELECT COALESCE(SUM(amount), 0)::float AS units FROM transactions WHERE user_id = ${member.id} AND token = ${payload.fromToken}`,
              ),
            )).rows as { units: number }[]
            const available = Number(unitRows[0]?.units ?? 0) * fromPrice
            if (payload.eurAmount > available * 1.001 + 0.01)
              return yield* Effect.fail(
                new BadRequest({
                  reason: `amount exceeds position: ${payload.eurAmount} > ${available.toFixed(2)} ${payload.fromToken}`,
                }),
              )
            const now = new Date()
            const rows = yield* withDb((db) =>
              db
                .insert(transactions)
                .values([
                  {
                    address: signer,
                    amount: -payload.eurAmount / fromPrice,
                    date: now,
                    movement: -payload.eurAmount,
                    token: payload.fromToken,
                    type: 'conversion',
                    userId: member.id,
                  },
                  {
                    address: signer,
                    amount: payload.eurAmount / toPrice,
                    date: now,
                    movement: payload.eurAmount,
                    token: payload.toToken,
                    type: 'conversion',
                    userId: member.id,
                  },
                ])
                .returning(),
            )
            return rows
          }),
        )
        .handle('votes', () =>
          Effect.gen(function* () {
            const request = yield* HttpServerRequest.HttpServerRequest
            const signer = yield* optionalWalletRequest(request)
            return yield* loadVotesWithResults(signer)
          }),
        )
        .handle('createVote', ({ payload }) =>
          Effect.gen(function* () {
            const request = yield* HttpServerRequest.HttpServerRequest
            const signer = yield* verifyWalletRequest(request)
            yield* requireAdmin(signer)
            const created = yield* withDb((db) =>
              db
                .insert(votes)
                .values({
                  closesAt: payload.closesAt ?? null,
                  description: payload.description ?? null,
                  kind: payload.kind,
                  title: payload.title,
                })
                .returning(),
            )
            const vote = created[0]
            if (!vote) return yield* Effect.fail(insertFailed())
            yield* withDb((db) =>
              db
                .insert(voteOptions)
                .values(payload.options.map((label, sortOrder) => ({ label, sortOrder, voteId: vote.id }))),
            )
            const list = yield* loadVotesWithResults(Option.some(signer))
            const found = list.find((v) => v.id === vote.id)
            if (!found) return yield* Effect.fail(notFound(`vote ${vote.id}`))
            return found
          }),
        )
        .handle('updateVote', ({ path, payload }) =>
          Effect.gen(function* () {
            const request = yield* HttpServerRequest.HttpServerRequest
            const signer = yield* verifyWalletRequest(request)
            yield* requireAdmin(signer)
            const rows = yield* withDb((db) =>
              db.update(votes).set({ status: payload.status }).where(eq(votes.id, path.id)).returning(),
            )
            if (!rows[0]) return yield* Effect.fail(notFound(`vote ${path.id}`))
            const list = yield* loadVotesWithResults(Option.some(signer))
            const found = list.find((v) => v.id === path.id)
            if (!found) return yield* Effect.fail(notFound(`vote ${path.id}`))
            return found
          }),
        )
        .handle('castBallot', ({ path, payload }) =>
          Effect.gen(function* () {
            const request = yield* HttpServerRequest.HttpServerRequest
            const signer = yield* verifyWalletRequest(request)
            const voteRows = yield* withDb((db) => db.select().from(votes).where(eq(votes.id, path.id)))
            const vote = voteRows[0]
            if (!vote) return yield* Effect.fail(notFound(`vote ${path.id}`))
            if (vote.status !== 'open' || (vote.closesAt && vote.closesAt.getTime() < Date.now()))
              return yield* Effect.fail(new BadRequest({ reason: 'vote is not open' }))
            const memberRows = yield* withDb((db) =>
              db.select({ id: users.id }).from(users).where(eq(users.address, signer)),
            )
            const member = memberRows[0]
            if (!member) return yield* Effect.fail(new BadRequest({ reason: 'signer is not a FiMs member' }))
            const optionRows = yield* withDb((db) =>
              db.select({ id: voteOptions.id }).from(voteOptions).where(eq(voteOptions.voteId, path.id)),
            )
            if (!optionRows.some((o) => o.id === payload.optionId))
              return yield* Effect.fail(
                new BadRequest({ reason: `option ${payload.optionId} is not part of this vote` }),
              )
            yield* withDb((db) =>
              db
                .insert(voteBallots)
                .values({ optionId: payload.optionId, userId: member.id, voteId: path.id })
                .onConflictDoUpdate({
                  set: { optionId: payload.optionId },
                  target: [voteBallots.voteId, voteBallots.userId],
                }),
            )
            const list = yield* loadVotesWithResults(Option.some(signer))
            const found = list.find((v) => v.id === path.id)
            if (!found) return yield* Effect.fail(notFound(`vote ${path.id}`))
            return found
          }),
        )
    )
  }),
).pipe(Layer.provide([DatabaseService.Default]))
