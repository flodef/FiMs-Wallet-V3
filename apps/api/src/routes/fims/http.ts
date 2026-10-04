import { HttpApiBuilder, HttpServerRequest } from '@effect/platform'
import { and, asc, desc, eq, getTableColumns, ilike, inArray, isNull, or, type SQL, sql } from 'drizzle-orm'
import { Effect, Layer, Option } from 'effect'
import { Api } from '../../api.js'
import {
  addressBook,
  adminAuditLog,
  dashboardMetrics,
  historic,
  prices,
  tokens,
  transactions,
  userAddresses,
  userHistoric,
  users,
  voteBallots,
  voteOptions,
  votes,
} from '../../db/schema.js'
import { DatabaseError, DatabaseService, withDb, withTransaction } from '../../db/service.js'
import { getFimsFeeRate } from '../../fee-config.js'
import {
  AuthForbidden,
  isAdminAddress,
  optionalWalletRequest,
  requireAdmin,
  requireNotDemo,
  verifyAddressSignature,
  verifyWalletRequest,
} from '../../services/auth/service.js'
import { BadRequest, RateLimited } from './api.js'

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

// An address reaches a member either as users.address (canonical) or through
// a user_addresses alias — every member resolution must go through this so a
// linked wallet inherits the member's visibility and write rights.
const addressLinkedToUser = (address: string) =>
  or(
    eq(users.address, address),
    sql`${users.id} in (select ${userAddresses.userId} from ${userAddresses} where ${userAddresses.address} = ${address})`,
  )

// Like requireOwnerOrAdmin but for multi-wallet members: any address linked
// to the user (canonical or alias) signs with equal rights. Also yields the
// 404 the previous ownerAddressOfUser lookup produced.
const requireLinkedOrAdmin = (signer: string, userId: number) =>
  Effect.gen(function* () {
    yield* userAccessOfId(userId)
    yield* requireNotDemo(signer)
    if (isAdminAddress(signer)) return
    const linked = yield* withDb((db) =>
      db
        .select({ id: users.id })
        .from(users)
        .where(and(eq(users.id, userId), addressLinkedToUser(signer))),
    )
    if (!linked.length) return yield* Effect.fail(new AuthForbidden({ address: signer }))
  })

// Canonical consent message the NEW wallet signs to accept being linked to a
// member (must match the client-side builder in fims-api.ts). Binding the
// user id prevents a consent signature captured on one link request from
// being replayed to attach the address to a different member.
export const linkAddressMessage = (userId: number, address: string) =>
  new TextEncoder().encode(`fims-wallet-v3\nlink-address\n${userId}\n${address}`)

// A non-public user's data is only visible to that user (signed) or an admin.
// Any other signer is just a keypair — same visibility as anonymous.
// The filter lives in the WHERE clause: filtering after LIMIT/OFFSET would
// silently truncate pages.
const visibilityFilter = (signer: Option.Option<string>) =>
  Option.match(signer, {
    onNone: () => eq(users.isPublic, true),
    onSome: (s) => (isAdminAddress(s) ? undefined : or(eq(users.isPublic, true), addressLinkedToUser(s))),
  })

const userAccessOfId = (userId: number) =>
  withDb((db) =>
    db.select({ address: users.address, isPublic: users.isPublic }).from(users).where(eq(users.id, userId)),
  ).pipe(
    Effect.flatMap((rows) => (rows[0] ? Effect.succeed<UserAccess>(rows[0]) : Effect.fail(notFound(`user ${userId}`)))),
  )

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

const ownerUserIdOfAddressBookEntry = (id: number) =>
  withDb((db) => db.select({ userId: addressBook.userId }).from(addressBook).where(eq(addressBook.id, id))).pipe(
    Effect.flatMap((rows) =>
      rows[0] ? Effect.succeed(rows[0].userId) : Effect.fail(notFound(`address book entry ${id}`)),
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
// contributions (donations flagged donation_target='tontine' — gifts to
// external associations and ~1% tips attached to a member's own operation
// never reach the pot); an investment ballot weighs the member's latest
// invested amount (same weighting rule as the legacy spreadsheet).
const loadVoteWeights = Effect.gen(function* () {
  const investedRows = (yield* withDb((db) =>
    db.execute(
      sql`SELECT DISTINCT ON (user_id) user_id, invested::float AS invested FROM user_historic ORDER BY user_id, date DESC`,
    ),
  )).rows as { invested: number; user_id: number }[]
  const tontineRows = (yield* withDb((db) =>
    db.execute(
      sql`SELECT user_id, SUM(movement)::float AS weight FROM transactions WHERE donation_target = 'tontine' AND movement > 0 GROUP BY user_id`,
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
          withDb((db) => db.select({ id: users.id }).from(users).where(addressLinkedToUser(address))).pipe(
            Effect.map((rows) => rows[0] ?? null),
          ),
      }),
    ])
    const signerUserId = signerUser?.id ?? null
    return voteRows.map((vote) => {
      const weightMap = vote.kind === 'tontine' ? weights.tontine : weights.invested
      const weightOf = (userId: number) => weightMap.get(userId) ?? 0
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
        eligibleWeight: [...weightMap.values()].reduce((sum, w) => sum + w, 0),
        myOptionId: ballots.find((b) => b.userId === signerUserId)?.optionId ?? null,
        myWeight: signerUserId === null ? null : weightOf(signerUserId),
        options,
        totalWeight: options.reduce((sum, o) => sum + o.weight, 0),
      }
    })
  })

// V2 rule: |movement - cost| ~= 0 marks a donation (in) or a payment (out),
// anything else is a deposit/withdrawal. Applied at write time so stored rows
// always carry a type — SQL filters on `type` would silently drop NULLs.
// The operating fee (getFimsFeeRate, currently 0.2%) is deducted from the
// credited side — the residual stays in the treasury, credited to no one.

// Prices feed ledger writes: a price older than the feed cadence is a free
// option against the treasury, so conversions refuse to use it.
const PRICE_STALE_MS = 10 * 60 * 1000
// Bounds what a stolen member key can bleed through back-and-forth
// conversions (each round-trip burns the fee). Generous enough to never
// block a legitimate rebalance.
const MAX_DAILY_CONVERT_EUR = 250_000

// Append-only record of privileged actions. Only logged when an admin acts
// on a resource they do not own — that is exactly the set of writes that
// move the community ledger or other members' data.
const auditAdmin = (signer: string, action: string, resourceId: string, detail?: unknown) =>
  isAdminAddress(signer)
    ? withDb((db) =>
        db.insert(adminAuditLog).values({
          action,
          adminAddress: signer,
          detail: detail === undefined ? null : JSON.stringify(detail).slice(0, 2000),
          resourceId,
        }),
      )
    : Effect.void

const deriveTransactionType = (
  movement: number,
  cost: number,
  counterpartyIsCex = false,
): 'cex_in' | 'cex_out' | 'deposit' | 'donation' | 'payment' | 'withdrawal' => {
  if (counterpartyIsCex) return movement > 0 ? 'cex_in' : 'cex_out'
  const special = Math.abs(movement - cost) < 0.01
  return movement > 0 ? (special ? 'donation' : 'deposit') : special ? 'payment' : 'withdrawal'
}

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
                .select({
                  ...getTableColumns(users),
                  // All linked addresses (canonical + aliases) so the client
                  // can recognize a member from any of its wallets.
                  addresses: sql<
                    string[]
                  >`array_prepend(${users.address}, coalesce((select array_agg(${userAddresses.address}) from ${userAddresses} where ${userAddresses.userId} = ${users.id}), '{}'))`.as(
                    'addresses',
                  ),
                })
                .from(users)
                .where(
                  and(
                    urlParams.name ? ilike(users.name, urlParams.name) : undefined,
                    urlParams.address ? addressLinkedToUser(urlParams.address) : undefined,
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
            // Self-registration only: the owner check is inlined (not
            // requireOwnerOrAdmin) because the public demo wallet must be
            // allowed to register its own row during the guided tour.
            if (signer !== payload.address) {
              yield* requireAdmin(signer)
            }
            // Display names are unique across members — same rule as
            // updateUser. Without it, self-registration could squat another
            // member's public name. Admins keep the override.
            if (!isAdminAddress(signer)) {
              const taken = yield* withDb((db) =>
                db.select({ id: users.id }).from(users).where(eq(users.name, payload.name)),
              )
              if (taken.length)
                return yield* Effect.fail(new BadRequest({ reason: `name already taken: ${payload.name}` }))
            }
            const rows = yield* withDb((db) => db.insert(users).values(payload).returning())
            const created = rows[0]
            if (!created) return yield* Effect.fail(insertFailed())
            yield* auditAdmin(signer, 'create_user', String(created.id), payload)
            return created
          }),
        )
        .handle('updateUser', ({ path, payload }) =>
          Effect.gen(function* () {
            const request = yield* HttpServerRequest.HttpServerRequest
            const signer = yield* verifyWalletRequest(request)
            yield* requireLinkedOrAdmin(signer, path.id)
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
            yield* auditAdmin(signer, 'update_user', String(updated.id), payload)
            return updated
          }),
        )
        .handle('deleteUser', ({ path }) =>
          Effect.gen(function* () {
            const request = yield* HttpServerRequest.HttpServerRequest
            const signer = yield* verifyWalletRequest(request)
            yield* requireLinkedOrAdmin(signer, path.id)
            const rows = yield* withDb((db) =>
              db.delete(users).where(eq(users.id, path.id)).returning({ id: users.id }),
            )
            if (!rows[0]) return yield* Effect.fail(notFound(`user ${path.id}`))
            yield* auditAdmin(signer, 'delete_user', String(path.id))
            return `deleted user ${path.id}`
          }),
        )
        // Multi-wallet members: attach an extra address to a user. The HTTP
        // signature proves an already-linked wallet consents; `payload.signature`
        // proves the NEW address consents too — neither side can squat alone.
        .handle('addUserAddress', ({ path, payload }) =>
          Effect.gen(function* () {
            const request = yield* HttpServerRequest.HttpServerRequest
            const signer = yield* verifyWalletRequest(request)
            yield* requireLinkedOrAdmin(signer, path.id)
            if (!isAdminAddress(signer)) {
              if (!payload.signature)
                return yield* Effect.fail(new BadRequest({ reason: 'missing link consent signature' }))
              if (
                !verifyAddressSignature(
                  payload.address,
                  linkAddressMessage(path.id, payload.address),
                  payload.signature,
                )
              )
                return yield* Effect.fail(new BadRequest({ reason: 'invalid link consent signature' }))
            }
            // A canonical users.address already identifies a member: it can
            // never become an alias (resolution would be ambiguous).
            const canonical = yield* withDb((db) =>
              db.select({ id: users.id }).from(users).where(eq(users.address, payload.address)),
            )
            if (canonical[0])
              return yield* Effect.fail(
                new BadRequest({
                  reason:
                    canonical[0].id === path.id
                      ? 'address is already the canonical address of this member'
                      : 'address already belongs to another member',
                }),
              )
            const existing = yield* withDb((db) =>
              db
                .select({ userId: userAddresses.userId })
                .from(userAddresses)
                .where(eq(userAddresses.address, payload.address)),
            )
            if (existing[0]) {
              if (existing[0].userId === path.id)
                return yield* Effect.fail(new BadRequest({ reason: 'address is already linked to this member' }))
              // Moving an alias between members would silently hand one
              // member's history to another — admins must unlink first.
              return yield* Effect.fail(new BadRequest({ reason: 'address is already linked to another member' }))
            }
            const rows = yield* withDb((db) =>
              db.insert(userAddresses).values({ address: payload.address, userId: path.id }).returning(),
            )
            const created = rows[0]
            if (!created) return yield* Effect.fail(insertFailed())
            yield* auditAdmin(signer, 'link_user_address', `${path.id}/${payload.address}`, payload)
            return created
          }),
        )
        .handle('removeUserAddress', ({ path }) =>
          Effect.gen(function* () {
            const request = yield* HttpServerRequest.HttpServerRequest
            const signer = yield* verifyWalletRequest(request)
            yield* requireLinkedOrAdmin(signer, path.id)
            const rows = yield* withDb((db) =>
              db
                .delete(userAddresses)
                .where(and(eq(userAddresses.userId, path.id), eq(userAddresses.address, path.address)))
                .returning({ id: userAddresses.id }),
            )
            if (!rows[0]) return yield* Effect.fail(notFound(`linked address ${path.address}`))
            yield* auditAdmin(signer, 'unlink_user_address', `${path.id}/${path.address}`)
            return `unlinked address ${path.address} from user ${path.id}`
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
            // account contents must equal the matching transactions exactly),
            // anything else ('association', …) is a gift to an external
            // organism. Reject rather than guess.
            if (type === 'donation' && !payload.donationTarget)
              return yield* Effect.fail(new BadRequest({ reason: 'donationTarget is required for a donation' }))
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
            yield* auditAdmin(signer, 'update_transaction', String(path.id), payload)
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
            yield* auditAdmin(signer, 'delete_transaction', String(path.id))
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
            yield* requireLinkedOrAdmin(signer, payload.userId)
            const rows = yield* withDb((db) =>
              db
                .insert(addressBook)
                .values({ ...payload, type: payload.type ?? 'other' })
                .returning(),
            )
            const created = rows[0]
            if (!created) return yield* Effect.fail(insertFailed())
            yield* auditAdmin(signer, 'create_address_book_entry', String(created.id), payload)
            return created
          }),
        )
        .handle('updateAddressBookEntry', ({ path, payload }) =>
          Effect.gen(function* () {
            const request = yield* HttpServerRequest.HttpServerRequest
            const signer = yield* verifyWalletRequest(request)
            const owner = yield* ownerUserIdOfAddressBookEntry(path.id)
            yield* requireLinkedOrAdmin(signer, owner)
            const rows = yield* withDb((db) =>
              db.update(addressBook).set(payload).where(eq(addressBook.id, path.id)).returning(),
            )
            const updated = rows[0]
            if (!updated) return yield* Effect.fail(notFound(`address book entry ${path.id}`))
            yield* auditAdmin(signer, 'update_address_book_entry', String(path.id), payload)
            return updated
          }),
        )
        .handle('deleteAddressBookEntry', ({ path }) =>
          Effect.gen(function* () {
            const request = yield* HttpServerRequest.HttpServerRequest
            const signer = yield* verifyWalletRequest(request)
            const owner = yield* ownerUserIdOfAddressBookEntry(path.id)
            yield* requireLinkedOrAdmin(signer, owner)
            const rows = yield* withDb((db) =>
              db.delete(addressBook).where(eq(addressBook.id, path.id)).returning({ id: addressBook.id }),
            )
            if (!rows[0]) return yield* Effect.fail(notFound(`address book entry ${path.id}`))
            yield* auditAdmin(signer, 'delete_address_book_entry', String(path.id))
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
            yield* requireNotDemo(signer)
            const memberRows = yield* withDb((db) =>
              db.select({ id: users.id }).from(users).where(addressLinkedToUser(signer)),
            )
            const member = memberRows[0]
            if (!member) return yield* Effect.fail(new BadRequest({ reason: 'signer is not a FiMs member' }))
            if (payload.fromToken === payload.toToken)
              return yield* Effect.fail(new BadRequest({ reason: 'source and destination tokens must differ' }))
            const priceRows = yield* withDb((db) =>
              db
                .select({ symbol: tokens.symbol, updatedAt: tokens.updatedAt, value: tokens.value })
                .from(tokens)
                .where(inArray(tokens.symbol, [payload.fromToken, payload.toToken])),
            )
            const priceOf = new Map(priceRows.map((r) => [r.symbol, r]))
            const fromToken = priceOf.get(payload.fromToken)
            const toToken = priceOf.get(payload.toToken)
            const fromPrice = fromToken?.value
            const toPrice = toToken?.value
            if (fromPrice == null || fromPrice <= 0 || toPrice == null || toPrice <= 0)
              return yield* Effect.fail(new BadRequest({ reason: 'unknown or unpriced token' }))
            // A stale price is a free option against the treasury: if the
            // feed stalls, conversions stop instead of trading at it.
            for (const token of [fromToken, toToken]) {
              if (token && Date.now() - token.updatedAt.getTime() > PRICE_STALE_MS)
                return yield* Effect.fail(
                  new BadRequest({
                    reason: `stale price for ${token.symbol}: ${token.updatedAt.toISOString()}`,
                  }),
                )
            }
            // The per-day cap bounds what a stolen member key can bleed
            // through back-and-forth conversions (each round-trip burns the
            // fee). Generous enough to never block a legitimate rebalance.
            const dailyRows = (yield* withDb((db) =>
              db.execute(
                sql`SELECT COALESCE(SUM(-movement), 0)::float AS eur FROM transactions WHERE user_id = ${member.id} AND type = 'conversion' AND movement < 0 AND date >= NOW() - INTERVAL '24 hours'`,
              ),
            )).rows as { eur: number }[]
            if (Number(dailyRows[0]?.eur ?? 0) + payload.eurAmount > MAX_DAILY_CONVERT_EUR)
              return yield* Effect.fail(
                new BadRequest({ reason: `daily conversion limit of ${MAX_DAILY_CONVERT_EUR} EUR exceeded` }),
              )
            const now = new Date()
            // Session-level transaction: the member row lock serializes
            // concurrent conversions so each one re-reads the position
            // under the lock before writing — a racy double-read can no
            // longer overdraw the position. (user_id, request_id) is
            // unique, so a retried submission is deduplicated.
            const outcome = yield* withTransaction(async (tx) => {
              await tx.execute(sql`SELECT id FROM users WHERE id = ${member.id} FOR UPDATE`)
              const lockedUnits = (
                await tx.execute(
                  sql`SELECT COALESCE(SUM(amount), 0)::float AS units FROM transactions WHERE user_id = ${member.id} AND token = ${payload.fromToken}`,
                )
              ).rows as { units: number }[]
              const available = Number(lockedUnits[0]?.units ?? 0) * fromPrice
              if (payload.eurAmount > available * 1.001 + 0.01) {
                return {
                  insufficient: `amount exceeds position: ${payload.eurAmount} > ${available.toFixed(2)} ${payload.fromToken}`,
                } as const
              }
              const inserted = await tx
                .insert(transactions)
                .values([
                  {
                    address: signer,
                    amount: -payload.eurAmount / fromPrice,
                    date: now,
                    movement: -payload.eurAmount,
                    requestId: payload.requestId,
                    token: payload.fromToken,
                    type: 'conversion' as const,
                    userId: member.id,
                  },
                  {
                    // Credited side is net of the operating fee — the member's
                    // balance drops by the fee, which stays in the treasury.
                    address: signer,
                    amount: (payload.eurAmount * (1 - getFimsFeeRate())) / toPrice,
                    date: now,
                    movement: payload.eurAmount * (1 - getFimsFeeRate()),
                    // Suffixed id keeps the credit leg tagged for dedup while
                    // staying a distinct key under the (user_id, request_id)
                    // unique index — the pair cannot collide with itself.
                    requestId: `${payload.requestId}:credit`,
                    token: payload.toToken,
                    type: 'conversion' as const,
                    userId: member.id,
                  },
                ])
                .onConflictDoNothing({ target: [transactions.userId, transactions.requestId] })
                .returning()
              return { inserted } as const
            })
            if ('insufficient' in outcome) return yield* Effect.fail(new BadRequest({ reason: outcome.insufficient }))
            if (outcome.inserted.length) return outcome.inserted
            // Conflict on request_id: the same conversion was already
            // applied by an earlier attempt — return that pair, don't
            // double-apply.
            const existing = yield* withDb((db) =>
              db
                .select()
                .from(transactions)
                .where(
                  and(
                    eq(transactions.userId, member.id),
                    inArray(transactions.requestId, [payload.requestId, `${payload.requestId}:credit`]),
                  ),
                )
                .orderBy(asc(transactions.id)),
            )
            if (!existing.length) return yield* Effect.fail(insertFailed())
            return existing
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
            yield* auditAdmin(signer, 'create_vote', String(vote.id), payload)
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
            yield* auditAdmin(signer, 'update_vote', String(path.id), payload)
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
            yield* requireNotDemo(signer)
            const voteRows = yield* withDb((db) => db.select().from(votes).where(eq(votes.id, path.id)))
            const vote = voteRows[0]
            if (!vote) return yield* Effect.fail(notFound(`vote ${path.id}`))
            if (vote.status !== 'open' || (vote.closesAt && vote.closesAt.getTime() < Date.now()))
              return yield* Effect.fail(new BadRequest({ reason: 'vote is not open' }))
            const memberRows = yield* withDb((db) =>
              db.select({ id: users.id }).from(users).where(addressLinkedToUser(signer)),
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
