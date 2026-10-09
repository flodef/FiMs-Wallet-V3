import { HttpApiBuilder, HttpServerRequest } from '@effect/platform'
import { address as solAddress } from '@solana/kit'
import { and, asc, desc, eq, getTableColumns, ilike, inArray, isNull, like, or, type SQL, sql } from 'drizzle-orm'
import { Effect, Layer, Option } from 'effect'
import { Api } from '../../api.js'
import {
  custodialAddress,
  custodialBackingStatus,
  custodialMint,
  custodialRedeem,
  custodialSweep,
  type FimsWrappedProduct,
  productForBackingMint,
  productForWrappedMint,
  wrappedProductConfig,
} from '../../custodial.js'
import {
  addressBook,
  adminAuditLog,
  dashboardMetrics,
  fimsSettings,
  historic,
  prices,
  tokens,
  transactions,
  usedSignatures,
  userAddresses,
  userHistoric,
  users,
  voteBallots,
  voteOptions,
  votes,
  wrappedClaims,
} from '../../db/schema.js'
import {
  DatabaseError,
  type DatabaseNotConfigured,
  DatabaseService,
  type Db,
  withDb,
  withTransaction,
} from '../../db/service.js'
import { getFimsFeeRate } from '../../fee-config.js'
import {
  chainSymbolForMint,
  fetchHeliusAssets,
  fetchHeliusTransactions,
  heliusApiKeys,
  normalizeGtfaTransaction,
} from '../../helius.js'
import {
  AuthForbidden,
  AuthUnauthorized,
  createSession,
  deleteSession,
  isAdminAddress,
  optionalWalletRequest,
  requireAdmin,
  requireNotDemo,
  verifyAddressSignature,
  verifyFreshConfirmation,
  verifyWalletRequest,
} from '../../services/auth/service.js'
import { fetchDonationTransaction } from '../../solana-rpc.js'
import { cronAuthorized, runStrategyPass, strategyHealth } from '../../strategy-delegate.js'
import { reconcileTontineDonations } from '../../tontine-reconcile.js'
import { ballotChangeRetryAt } from '../../vote-ballot-rules.js'
import { BadRequest, ChainUnavailable, CustodialUnavailable, RateLimited } from './api.js'

const notFound = (what: string) => `not found: ${what}`
const insertFailed = () => new DatabaseError({ cause: 'insert returned no row' })

// The shared pot's wallet — donations land here on-chain. Mirrored client-side
// as FIMS_TONTINE_ADDRESS (packages/feature-fims/src/fims-constants.ts).
const FIMS_TONTINE_ADDRESS = 'Fe1RpesrtYMJdjwbNXtpVCDNpnFvk6jSic3sJd2aCBng'

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

// Identity management (link / unlink / delete) is canonical-address only:
// an alias wallet has full usage rights but a single compromised alias key
// must not be able to destroy or hijack the member it belongs to.
const requireCanonicalOrAdmin = (signer: string, userId: number) =>
  Effect.gen(function* () {
    yield* userAccessOfId(userId)
    yield* requireNotDemo(signer)
    if (isAdminAddress(signer)) return
    const canonical = yield* withDb((db) =>
      db
        .select({ id: users.id })
        .from(users)
        .where(and(eq(users.id, userId), eq(users.address, signer))),
    )
    if (!canonical.length) return yield* Effect.fail(new AuthForbidden({ address: signer }))
  })

// Resolve the member a signer belongs to (canonical or any linked alias) —
// most mutations are member-scoped; without it any signed keypair could act.
const requireMember = (
  signer: string,
): Effect.Effect<typeof users.$inferSelect, BadRequest | DatabaseError | DatabaseNotConfigured, DatabaseService> =>
  Effect.gen(function* () {
    const memberRows = yield* withDb((db) => db.select().from(users).where(addressLinkedToUser(signer)))
    const member = memberRows[0]
    if (!member) return yield* Effect.fail(new BadRequest({ reason: 'signer is not a FiMs member' }))
    return member
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
// Embedded gifts (donation_amount on an outflow row) contribute their EUR
// share at the row's implied rate: donation_amount × |movement + cost|/|amount|.
const loadVoteWeights = Effect.gen(function* () {
  const investedRows = (yield* withDb((db) =>
    db.execute(
      sql`SELECT DISTINCT ON (user_id) user_id, invested::float AS invested FROM user_historic ORDER BY user_id, date DESC`,
    ),
  )).rows as { invested: number; user_id: number }[]
  const tontineRows = (yield* withDb((db) =>
    db.execute(
      sql`SELECT user_id, SUM(
            CASE WHEN donation_amount IS NOT NULL AND amount IS NOT NULL AND amount <> 0
            THEN ABS(movement + cost) * donation_amount / ABS(amount)
            ELSE GREATEST(movement, 0) END
          )::float AS weight
          FROM transactions
          WHERE donation_target = 'tontine' AND (movement > 0 OR donation_amount IS NOT NULL)
          GROUP BY user_id`,
    ),
  )).rows as { user_id: number; weight: number }[]
  const invested = new Map(investedRows.map((r) => [r.user_id, Number(r.invested)]))
  const tontine = new Map(tontineRows.map((r) => [r.user_id, Number(r.weight)]))
  return { invested, tontine }
})

// Admin-tunable config. The proposal threshold is the share of total invested
// assets a member must strictly exceed to submit a tontine proposal.
const PROPOSAL_THRESHOLD_KEY = 'proposal_threshold'
const DEFAULT_PROPOSAL_THRESHOLD = 0.01

const loadFimsConfig = Effect.gen(function* () {
  const [settingsRows, weights] = yield* Effect.all([
    withDb((db) => db.select().from(fimsSettings).where(eq(fimsSettings.key, PROPOSAL_THRESHOLD_KEY))),
    loadVoteWeights,
  ])
  const parsed = Number.parseFloat(settingsRows[0]?.value ?? '')
  const proposalThreshold = Number.isFinite(parsed) && parsed > 0 && parsed <= 1 ? parsed : DEFAULT_PROPOSAL_THRESHOLD
  return {
    proposalThreshold,
    totalInvested: [...weights.invested.values()].reduce((sum, value) => sum + value, 0),
  }
})

const loadVotesWithResults = (signer: Option.Option<string>) =>
  Effect.gen(function* () {
    const [voteRows, optionRows, ballotRows, weights, signerUser, userRows] = yield* Effect.all([
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
      withDb((db) => db.select({ id: users.id, name: users.name }).from(users)),
    ])
    const userNames = new Map(userRows.map((u) => [u.id, u.name]))
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
        myBallotUpdatedAt: ballots.find((b) => b.userId === signerUserId)?.updatedAt ?? null,
        myOptionId: ballots.find((b) => b.userId === signerUserId)?.optionId ?? null,
        myWeight: signerUserId === null ? null : weightOf(signerUserId),
        options,
        proposerName: vote.proposerId === null ? null : (userNames.get(vote.proposerId) ?? null),
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

// Wrapped-product circuit breakers (see wrappedTransfer): the operator price
// may not jump more than this fraction away from the last ledger-implied
// price, and rolling-24h caps bound mint+redeem volume in product units —
// per member and globally. All overridable via env for ops tuning.
const wrappedPriceBreaker = () => Number.parseFloat(process.env['FIMS_WRAPPED_PRICE_BREAKER'] ?? '0.1')
const wrappedDailyCap = (scope: 'global' | 'member') =>
  Number.parseFloat(
    process.env[scope === 'member' ? 'FIMS_WRAPPED_MEMBER_DAILY_UNITS' : 'FIMS_WRAPPED_GLOBAL_DAILY_UNITS'] ??
      (scope === 'member' ? '10000' : '50000'),
  )
// Bounds what a stolen member key can bleed through back-and-forth
// conversions (each round-trip burns the fee). Generous enough to never
// block a legitimate rebalance.
const MAX_DAILY_CONVERT_EUR = 250_000

// Append-only record of ledger mutations — every signer, not just admins:
// a compromised member key must be reconstructible too. `admin_address`
// holds the acting signer (the column name is historical).
const auditAdmin = (signer: string, action: string, resourceId: string, detail?: unknown) =>
  withDb((db) =>
    db.insert(adminAuditLog).values({
      action,
      adminAddress: signer,
      detail: detail === undefined ? null : JSON.stringify(detail).slice(0, 2000),
      resourceId,
    }),
  )

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
        // SIWS sign-in: one signature → bearer session (7d). The signed path
        // stays for compatibility, but clients should only need it once.
        .handle('createSession', ({ payload }) =>
          Effect.gen(function* () {
            const request = yield* HttpServerRequest.HttpServerRequest
            return yield* createSession(request, payload)
          }),
        )
        .handle('deleteSession', () =>
          Effect.gen(function* () {
            const request = yield* HttpServerRequest.HttpServerRequest
            return yield* deleteSession(request)
          }),
        )
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
            yield* requireCanonicalOrAdmin(signer, path.id)
            // Step-up: a bearer session alone cannot destroy a member — the
            // wallet must re-sign this exact action.
            yield* verifyFreshConfirmation(request, signer)
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
            yield* requireCanonicalOrAdmin(signer, path.id)
            yield* verifyFreshConfirmation(request, signer)
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
            yield* requireCanonicalOrAdmin(signer, path.id)
            yield* verifyFreshConfirmation(request, signer)
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
            // donationAmount is an extra gift outflow on top of `amount`
            // (e.g. a withdrawal also carrying its tontine share): it needs a
            // target, stays positive, and only makes sense on outflow rows.
            if (payload.donationAmount != null) {
              if (type === 'donation' || type === 'payment' || type === 'tontine')
                return yield* Effect.fail(new BadRequest({ reason: `donationAmount is redundant on a ${type} row` }))
              if (!payload.donationTarget)
                return yield* Effect.fail(
                  new BadRequest({ reason: 'donationTarget is required when donationAmount is set' }),
                )
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
          }),
        )
        .handle('updateTransaction', ({ path, payload }) =>
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
                  return yield* Effect.fail(
                    new BadRequest({ reason: `donationAmount is redundant on a ${merged.type} row` }),
                  )
                if (!merged.donationTarget)
                  return yield* Effect.fail(
                    new BadRequest({ reason: 'donationTarget is required when donationAmount is set' }),
                  )
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
            const member = yield* requireMember(signer)
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
            const now = new Date()
            // Session-level transaction: the member row lock serializes
            // concurrent conversions so each one re-reads the position AND
            // the daily cap under the lock before writing — a racy
            // double-read can no longer overdraw the position nor double
            // the daily quota. (user_id, request_id) is unique, so a
            // retried submission is deduplicated.
            const outcome = yield* withTransaction(async (tx) => {
              await tx.execute(sql`SELECT id FROM users WHERE id = ${member.id} FOR UPDATE`)
              // The per-day cap bounds what a stolen member key can bleed
              // through back-and-forth conversions (each round-trip burns
              // the fee). Checked under the member lock — parallel requests
              // cannot both see headroom and slip past the cap.
              const dailyRows = (
                await tx.execute(
                  sql`SELECT COALESCE(SUM(-movement), 0)::float AS eur FROM transactions WHERE user_id = ${member.id} AND type = 'conversion' AND movement < 0 AND date >= NOW() - INTERVAL '24 hours'`,
                )
              ).rows as { eur: number }[]
              if (Number(dailyRows[0]?.eur ?? 0) + payload.eurAmount > MAX_DAILY_CONVERT_EUR) {
                return {
                  capExceeded: `daily conversion limit of ${MAX_DAILY_CONVERT_EUR} EUR exceeded`,
                } as const
              }
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
            if ('capExceeded' in outcome) return yield* Effect.fail(new BadRequest({ reason: outcome.capExceeded }))
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
            // Members submit tontine proposals; they land as drafts an admin
            // must open. Eligibility: the proposer's latest invested amount
            // must strictly exceed proposal_threshold × total invested.
            let proposerId: number | null = null
            if (!isAdminAddress(signer)) {
              yield* requireNotDemo(signer)
              if (payload.kind !== 'tontine')
                return yield* Effect.fail(new BadRequest({ reason: 'member proposals must target the tontine' }))
              const member = yield* requireMember(signer)
              const [config, weights] = yield* Effect.all([loadFimsConfig, loadVoteWeights])
              const invested = weights.invested.get(member.id) ?? 0
              if (!(invested > config.proposalThreshold * config.totalInvested))
                return yield* Effect.fail(new AuthForbidden({ address: signer }))
              proposerId = member.id
            }
            // Vote + options in one transaction — a failed options insert
            // used to leave a vote with no options (permanently unusable).
            const created = yield* withTransaction(async (tx) => {
              const inserted = await tx
                .insert(votes)
                .values({
                  closesAt: payload.closesAt ?? null,
                  description: payload.description ?? null,
                  kind: isAdminAddress(signer) ? payload.kind : 'tontine',
                  proposerId,
                  title: payload.title,
                })
                .returning()
              const vote = inserted[0]
              if (!vote) return null
              await tx
                .insert(voteOptions)
                .values(payload.options.map((label, sortOrder) => ({ label, sortOrder, voteId: vote.id })))
              return vote
            })
            const vote = created
            if (!vote) return yield* Effect.fail(insertFailed())
            yield* auditAdmin(signer, 'create_vote', String(vote.id), payload)
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
            const member = yield* requireMember(signer)
            const optionRows = yield* withDb((db) =>
              db.select({ id: voteOptions.id }).from(voteOptions).where(eq(voteOptions.voteId, path.id)),
            )
            if (!optionRows.some((o) => o.id === payload.optionId))
              return yield* Effect.fail(
                new BadRequest({ reason: `option ${payload.optionId} is not part of this vote` }),
              )
            // A decision can be changed once per 24 h — re-selecting the same
            // option is a no-op, not a change. The member lock serializes
            // concurrent casts so the cooldown cannot be double-passed.
            const ballotOutcome = yield* withTransaction(async (tx) => {
              await tx.execute(sql`SELECT id FROM users WHERE id = ${member.id} FOR UPDATE`)
              const existingBallots = await tx
                .select({ optionId: voteBallots.optionId, updatedAt: voteBallots.updatedAt })
                .from(voteBallots)
                .where(and(eq(voteBallots.voteId, path.id), eq(voteBallots.userId, member.id)))
              const retryAt = ballotChangeRetryAt(existingBallots[0] ?? null, payload.optionId)
              if (retryAt) return { retryAt } as const
              await tx
                .insert(voteBallots)
                .values({ optionId: payload.optionId, userId: member.id, voteId: path.id })
                .onConflictDoUpdate({
                  set: { optionId: payload.optionId, updatedAt: new Date() },
                  target: [voteBallots.voteId, voteBallots.userId],
                })
              return { cast: true } as const
            })
            if ('retryAt' in ballotOutcome) {
              return yield* Effect.fail(
                new BadRequest({
                  reason: `ballot changeable once per day — retry at ${ballotOutcome.retryAt.toISOString()}`,
                }),
              )
            }
            const list = yield* loadVotesWithResults(Option.some(signer))
            const found = list.find((v) => v.id === path.id)
            if (!found) return yield* Effect.fail(notFound(`vote ${path.id}`))
            return found
          }),
        )
        .handle('config', () =>
          Effect.gen(function* () {
            return yield* loadFimsConfig
          }),
        )
        .handle('updateConfig', ({ payload }) =>
          Effect.gen(function* () {
            const request = yield* HttpServerRequest.HttpServerRequest
            const signer = yield* verifyWalletRequest(request)
            yield* requireAdmin(signer)
            yield* withDb((db) =>
              db
                .insert(fimsSettings)
                .values({ key: PROPOSAL_THRESHOLD_KEY, value: String(payload.proposalThreshold) })
                .onConflictDoUpdate({
                  set: { updatedAt: new Date(), value: String(payload.proposalThreshold) },
                  target: fimsSettings.key,
                }),
            )
            yield* auditAdmin(signer, 'update_config', PROPOSAL_THRESHOLD_KEY, payload)
            return yield* loadFimsConfig
          }),
        )
        .handle('recordDonation', ({ payload }) =>
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
              return yield* Effect.fail(new BadRequest({ reason: 'transaction not found, failed, or not confirmed' }))
            if (!fetched.deltas.length)
              return yield* Effect.fail(new BadRequest({ reason: 'transaction did not credit the tontine wallet' }))
            // The fee payer must belong to the signer: recording someone
            // else's gift under your own name would inflate your vote weight
            // and erase your debt for free.
            const payerRows = yield* withDb((db) =>
              db.select({ id: users.id }).from(users).where(addressLinkedToUser(fetched.payer)),
            )
            if (payerRows[0]?.id !== member.id)
              return yield* Effect.fail(
                new BadRequest({ reason: 'donation sender is not linked to your member account' }),
              )

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
              const committed = await tx
                .select()
                .from(transactions)
                .where(eq(transactions.signature, payload.signature))
              if (committed.length) return committed
              return tx
                .insert(transactions)
                .values(
                  fetched.deltas.map((delta) => {
                    const symbol = symbolOf(delta.mint)
                    const movement = symbol ? (priceOf(symbol) ?? 0) * delta.amount : 0
                    return {
                      address: fetched.payer,
                      amount: delta.amount,
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
              return yield* Effect.fail(
                new BadRequest({ reason: 'donation recording in flight — retry in a few seconds' }),
              )
            }
            if (!rows.length) return yield* Effect.fail(insertFailed())
            return rows
          }),
        )
        .handle('wrappedConfig', () =>
          Effect.gen(function* () {
            const custody = yield* Effect.tryPromise({
              catch: () => null,
              try: () => custodialAddress(),
            }).pipe(Effect.orElseSucceed(() => null))
            const products = (['fims-eur', 'fims-usd'] as const).flatMap((id) => {
              const config = wrappedProductConfig(id)
              return config
                ? [
                    {
                      backingMint: `${config.backingMint}`,
                      id,
                      mint: `${config.mint}`,
                      symbol: config.symbol,
                    },
                  ]
                : []
            })
            return { custody, products }
          }),
        )
        .handle('wrappedDeposit', ({ payload }) =>
          Effect.gen(function* () {
            return yield* wrappedTransfer(payload.signature, 'deposit')
          }),
        )
        .handle('wrappedRedeem', ({ payload }) =>
          Effect.gen(function* () {
            return yield* wrappedTransfer(payload.signature, 'redeem')
          }),
        )
        .handle('chainLabels', () =>
          Effect.gen(function* () {
            const request = yield* HttpServerRequest.HttpServerRequest
            const signer = yield* verifyWalletRequest(request)
            const { rows } = yield* withDb((db) => loadChainLabels(db, Option.some(signer)))
            return rows.slice(0, CHAIN_ADDRESS_MAX)
          }),
        )
        .handle('chainHistory', ({ urlParams }) =>
          Effect.gen(function* () {
            const request = yield* HttpServerRequest.HttpServerRequest
            const signer = yield* verifyWalletRequest(request)
            yield* consumeChainQuota(signer)
            const keys = yield* heliusKeysOrFail
            const limit = Math.min(Math.max(1, Math.floor(urlParams.limit ?? 100)), 100)
            const page = yield* Effect.tryPromise({
              catch: chainUnavailable,
              try: () => fetchHeliusTransactions(keys, urlParams.address, { cursor: urlParams.cursor, limit }),
            })
            const { labels, symbols } = yield* withDb((db) => loadChainLabels(db, Option.some(signer)))
            const flat = new Map([...labels.entries()].map(([a, v]) => [a, v.label] as const))
            return {
              cursor: page.paginationToken ?? null,
              transactions: page.data
                .map((tx) => normalizeGtfaTransaction(tx, urlParams.address, flat, symbols))
                .filter((tx) => tx !== null),
            }
          }),
        )
        .handle('chainAssets', ({ urlParams }) =>
          Effect.gen(function* () {
            const request = yield* HttpServerRequest.HttpServerRequest
            const signer = yield* verifyWalletRequest(request)
            yield* consumeChainQuota(signer)
            const keys = yield* heliusKeysOrFail
            const assets = yield* Effect.tryPromise({
              catch: chainUnavailable,
              try: () => fetchHeliusAssets(keys, urlParams.address),
            })
            const { symbols } = yield* withDb((db) => loadChainLabels(db, Option.some(signer)))
            return assets.map((asset) => ({
              ...asset,
              symbol: asset.mint ? (asset.symbol ?? chainSymbolForMint(asset.mint, symbols)) : 'SOL',
            }))
          }),
        )
        .handle('strategyStatus', () =>
          Effect.gen(function* () {
            const request = yield* HttpServerRequest.HttpServerRequest
            if (!cronAuthorized(request.headers['x-strategy-secret'] ?? null)) {
              return yield* Effect.fail(new AuthUnauthorized({ reason: 'invalid x-strategy-secret' }))
            }
            const { db } = yield* DatabaseService
            const health = yield* Effect.tryPromise({
              catch: (cause) => new DatabaseError({ cause }),
              try: () => strategyHealth(db),
            })
            // 503 (not 200-with-issues) so the uptime monitor fires on any
            // problem: stale pending deposits, failed ops, delegate broke.
            if (!health.healthy) {
              return yield* Effect.fail(new ChainUnavailable({ reason: health.issues.join('; ') }))
            }
            return health
          }),
        )
        .handle('strategyDelegateRun', () =>
          Effect.gen(function* () {
            const request = yield* HttpServerRequest.HttpServerRequest
            if (!cronAuthorized(request.headers['x-strategy-secret'] ?? null)) {
              return yield* Effect.fail(new AuthUnauthorized({ reason: 'invalid x-strategy-secret' }))
            }
            const { db } = yield* DatabaseService
            const report = yield* Effect.tryPromise({
              catch: (cause) =>
                new ChainUnavailable({ reason: cause instanceof Error ? cause.message : 'delegate pass failed' }),
              try: () => runStrategyPass(db),
            })
            // Piggyback the tontine reconcile on the same cron tick: the pot
            // sees so few transactions that one scan a minute is plenty, and
            // carving sends no longer depend on the client reporting them.
            // Best-effort — a reconcile hiccup must not fail the keeper pass.
            yield* Effect.tryPromise({
              catch: () => new ChainUnavailable({ reason: 'reconcile failed' }),
              try: () => reconcileTontineDonations(db),
            }).pipe(Effect.catchAll((error) => Effect.logWarning('tontine reconcile failed', error)))
            // Surface per-deposit failures as 503 so cron-job.org alerts —
            // the full detail stays in the strategy_ops table.
            const failed = report.deposits.filter((d) => d.error)
            if (failed.length > 0) {
              return yield* Effect.fail(
                new ChainUnavailable({ reason: failed.map((d) => `${d.member}: ${d.error}`).join('; ') }),
              )
            }
            return report
          }),
        )
        .handle('custodialBackingStatus', () =>
          Effect.gen(function* () {
            const request = yield* HttpServerRequest.HttpServerRequest
            if (!cronAuthorized(request.headers['x-strategy-secret'] ?? null)) {
              return yield* Effect.fail(new AuthUnauthorized({ reason: 'invalid x-strategy-secret' }))
            }
            const { db } = yield* DatabaseService
            const rows = yield* Effect.tryPromise({
              catch: (cause) =>
                new ChainUnavailable({ reason: cause instanceof Error ? cause.message : 'backing status failed' }),
              try: async () => {
                const tokenRows = await db.select().from(tokens)
                const prices = Object.fromEntries(
                  tokenRows.filter((row) => row.value !== null).map((row) => [row.symbol, row.value as number]),
                )
                return custodialBackingStatus(prices)
              },
            })
            const unbacked = rows.filter((row) => !row.healthy)
            if (unbacked.length > 0) {
              return yield* Effect.fail(
                new ChainUnavailable({
                  reason: `unbacked supply: ${unbacked.map((row) => row.product).join(', ')}`,
                }),
              )
            }
            return { products: rows }
          }),
        )
        .handle('custodialSweep', () =>
          Effect.gen(function* () {
            const request = yield* HttpServerRequest.HttpServerRequest
            if (!cronAuthorized(request.headers['x-strategy-secret'] ?? null)) {
              return yield* Effect.fail(new AuthUnauthorized({ reason: 'invalid x-strategy-secret' }))
            }
            const report = yield* Effect.tryPromise({
              catch: (cause) =>
                new ChainUnavailable({ reason: cause instanceof Error ? cause.message : 'sweep failed' }),
              try: async () => {
                const out = []
                for (const product of ['fims-eur', 'fims-usd'] as const) {
                  out.push(await custodialSweep(product))
                }
                return out
              },
            })
            return report.map((row) => ({
              product: row.product,
              signature: row.signature,
              swept: row.swept.toString(),
            }))
          }),
        )
    )
  }),
).pipe(Layer.provide([DatabaseService.Default]))

// Shared deposit/redeem pipeline: verify the member's on-chain transfer into
// custody, then let the custodial mint (deposit) or burn+refund (redeem).
// The ledger row is written in the wrapped symbol (EURF/USDF) at the current
// NAV — circuit breakers below bound what a manipulated index can do.
function wrappedTransfer(signature: string, direction: 'deposit' | 'redeem') {
  return Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest
    const signer = yield* verifyWalletRequest(request)
    yield* requireNotDemo(signer)
    const member = yield* requireMember(signer)
    // Only wrapped ledger rows ({sig}:{mint}) count as "already processed":
    // a transaction can ALSO appear as a donation row (same signature, no
    // suffix) when it carried a tontine carve — that must not block the mint.
    const existing = yield* withDb((db) =>
      db
        .select()
        .from(transactions)
        .where(like(transactions.signature, `${signature}:%`)),
    )
    if (existing.length) {
      return { custodialSignature: '', transactions: existing }
    }

    const custody = yield* Effect.tryPromise({
      catch: (error) => {
        console.error('custodial wallet unavailable', error)
        return new CustodialUnavailable({ reason: 'custodial wallet is not configured' })
      },
      try: () => custodialAddress(),
    })
    const tx = yield* Effect.tryPromise({
      catch: () => new BadRequest({ reason: 'cannot fetch transaction from the RPC' }),
      // Finalized only: minting irreversible wrapped units against a
      // merely-confirmed member transfer is not worth the reorg risk.
      try: () => fetchDonationTransaction(signature, `${custody}`, 'finalized'),
    })
    if (!tx) return yield* Effect.fail(new BadRequest({ reason: 'transaction not found, failed, or not finalized' }))
    const matches = tx.deltas
      .map((delta) => ({
        delta,
        product: direction === 'deposit' ? productForBackingMint(delta.mint) : productForWrappedMint(delta.mint),
      }))
      .filter((entry) => entry.product != null)
    if (!matches.length)
      return yield* Effect.fail(
        new BadRequest({
          reason:
            direction === 'deposit'
              ? 'transaction did not credit custody with EURC or USDG'
              : 'transaction did not return a wrapped FiMs token to custody',
        }),
      )
    const payerRows = yield* withDb((db) =>
      db.select({ id: users.id }).from(users).where(addressLinkedToUser(tx.payer)),
    )
    if (payerRows[0]?.id !== member.id)
      return yield* Effect.fail(new BadRequest({ reason: 'transaction sender is not linked to your member account' }))

    // Product units are priced by the operator-maintained index in `tokens`
    // (EURF tracks the FiMs Token NAV, USDF starts at 1), under three
    // circuit breakers:
    //   1. freshness — a stalled feed freezes mint/redeem (like convertPosition);
    //   2. rate-of-change — the index may not deviate more than
    //      FIMS_WRAPPED_PRICE_BREAKER (default 10%) from the price implied by
    //      the member's previous wrapped ledger row, so a manipulated or
    //      lagging feed cannot reprice a mint instantly;
    //   3. rolling-24h caps — per member and global, bounding what a stolen
    //      key or a bad price can move before humans react.
    // A symmetric operating fee (getFimsFeeRate) prices the spread that would
    // otherwise make NAV-lag arbitrage free.
    const prepared: {
      backingUnits: bigint
      delta: (typeof matches)[number]['delta']
      price: number
      product: FimsWrappedProduct
      productUnits: bigint
      symbol: string
    }[] = []
    for (const { delta, product } of matches) {
      const config = wrappedProductConfig(product as FimsWrappedProduct)
      if (!config) return yield* Effect.fail(new CustodialUnavailable({ reason: `${product} mint is not configured` }))
      if (delta.decimals !== 6)
        return yield* Effect.fail(new CustodialUnavailable({ reason: `${product} mint expects 6-decimal tokens` }))
      const tokenRows = yield* withDb((db) =>
        db
          .select({ updatedAt: tokens.updatedAt, value: tokens.value })
          .from(tokens)
          .where(eq(tokens.symbol, config.symbol)),
      )
      const tokenRow = tokenRows[0]
      const price = tokenRow?.value ?? 0
      if (price <= 0 || !tokenRow)
        return yield* Effect.fail(
          new CustodialUnavailable({ reason: `${config.symbol} price index is not configured` }),
        )
      if (Date.now() - tokenRow.updatedAt.getTime() > PRICE_STALE_MS)
        return yield* Effect.fail(
          new CustodialUnavailable({
            reason: `stale price for ${config.symbol}: ${tokenRow.updatedAt.toISOString()}`,
          }),
        )
      const lastImplied = (
        (yield* withDb((db) =>
          db.execute(
            sql`SELECT ABS(movement / amount)::float AS p FROM transactions WHERE token = ${config.symbol} AND type IN ('deposit', 'withdrawal') AND amount <> 0 ORDER BY date DESC LIMIT 1`,
          ),
        )).rows as { p: number }[]
      )[0]?.p
      if (lastImplied && Math.abs(price / lastImplied - 1) > wrappedPriceBreaker())
        return yield* Effect.fail(
          new CustodialUnavailable({
            reason: `${config.symbol} price moved ${(Math.abs(price / lastImplied - 1) * 100).toFixed(1)}% — circuit breaker`,
          }),
        )
      // Exact integer math: price and the fee are scaled to 1e9 fractions.
      const priceScaled = BigInt(Math.round(price * 1e9))
      const feeScaled = BigInt(Math.round((1 - getFimsFeeRate()) * 1e9))
      const received = delta.rawAmount
      const backingUnits =
        direction === 'deposit' ? received : (received * priceScaled * feeScaled) / 1_000_000_000_000_000_000n
      const productUnits = direction === 'deposit' ? (received * feeScaled) / priceScaled : received
      if (productUnits <= 0n || backingUnits <= 0n)
        return yield* Effect.fail(new BadRequest({ reason: 'amount too small' }))
      prepared.push({
        backingUnits,
        delta,
        price,
        product: product as FimsWrappedProduct,
        productUnits,
        symbol: config.symbol,
      })
    }

    // State machine, not a blind mint: wrapped_claims records each leg's
    // progress (claimed → minted → recorded). A crash mid-flight leaves a
    // durable mark a retry can resume from instead of re-minting or
    // blocking forever — see the wrapped_claims table comment for states.
    const claimOutcome = yield* withTransaction(async (tx) => {
      await tx.execute(sql`SELECT id FROM users WHERE id = ${member.id} FOR UPDATE`)
      const mints = prepared.map((row) => row.delta.mint)
      const existing = await tx
        .select()
        .from(wrappedClaims)
        .where(and(eq(wrappedClaims.signature, signature), inArray(wrappedClaims.mint, mints)))
      const byMint = new Map(existing.map((claim) => [claim.mint, claim]))
      // A 'claimed' leg means a previous request died between claim and
      // ledger write — a retried mint could double-credit the member, so it
      // blocks until an admin verifies the chain and unblocks the row.
      if (existing.some((claim) => claim.state === 'claimed')) return { inFlight: true } as const
      const replay = prepared.filter((row) => byMint.get(row.delta.mint)?.state === 'minted')
      const fresh = prepared.filter((row) => !byMint.has(row.delta.mint))
      // Caps only gate NEW legs — replaying a minted leg's ledger row must
      // never be refused (the units are already on-chain).
      const symbols = fresh.map((row) => row.symbol)
      if (symbols.length) {
        const memberUnits = (
          await tx.execute(
            sql`SELECT COALESCE(SUM(ABS(amount)), 0)::float AS units FROM transactions WHERE user_id = ${member.id} AND ${inArray(transactions.token, symbols)} AND type IN ('deposit', 'withdrawal') AND date >= NOW() - INTERVAL '24 hours'`,
          )
        ).rows as { units: number }[]
        const globalUnits = (
          await tx.execute(
            sql`SELECT COALESCE(SUM(ABS(amount)), 0)::float AS units FROM transactions WHERE ${inArray(transactions.token, symbols)} AND type IN ('deposit', 'withdrawal') AND date >= NOW() - INTERVAL '24 hours'`,
          )
        ).rows as { units: number }[]
        const requested = fresh.reduce((sum, row) => sum + Number(row.productUnits) / 1e6, 0)
        if (Number(memberUnits[0]?.units ?? 0) + requested > wrappedDailyCap('member'))
          return { limited: 'member daily wrapped limit exceeded' } as const
        if (Number(globalUnits[0]?.units ?? 0) + requested > wrappedDailyCap('global'))
          return { limited: 'global daily wrapped limit exceeded' } as const
      }
      for (const row of fresh) {
        await tx.insert(wrappedClaims).values({ mint: row.delta.mint, signature, state: 'claimed' })
      }
      return { fresh, replay } as const
    })
    if ('inFlight' in claimOutcome)
      return yield* Effect.fail(
        new BadRequest({ reason: 'this transfer is already being processed — retry in a minute' }),
      )
    if ('limited' in claimOutcome) return yield* Effect.fail(new BadRequest({ reason: claimOutcome.limited }))
    const { fresh, replay } = claimOutcome
    if (!fresh.length && !replay.length) {
      const rows = yield* withDb((db) =>
        db
          .select()
          .from(transactions)
          .where(like(transactions.signature, `${signature}:%`)),
      )
      return { custodialSignature: '', transactions: rows }
    }

    // Mint each fresh leg, then durably mark it minted — a retry replays the
    // ledger write without touching the chain again.
    const minted: ({ custodialSignature?: string } & (typeof fresh)[number])[] = [...replay]
    for (const row of fresh) {
      const custodialSignature = yield* Effect.tryPromise({
        catch: (error) => {
          console.error(`custodial ${direction} failed`, error)
          return new CustodialUnavailable({
            reason: `custodial ${direction} failed — the backing is safe; retry in a few minutes`,
          })
        },
        try: () =>
          direction === 'deposit'
            ? custodialMint(row.product, solAddress(tx.payer), row.productUnits, row.backingUnits)
            : custodialRedeem(row.product, solAddress(tx.payer), row.productUnits, row.backingUnits),
      })
      yield* withDb((db) =>
        db
          .update(wrappedClaims)
          .set({ custodialSignature, state: 'minted', updatedAt: new Date() })
          .where(and(eq(wrappedClaims.signature, signature), eq(wrappedClaims.mint, row.delta.mint))),
      )
      minted.push({ ...row, custodialSignature })
    }

    // Ledger rows + terminal state in one transaction per leg.
    const rows = []
    let custodialSignature = minted[0]?.custodialSignature ?? ''
    for (const row of minted) {
      const productAmount = Number(row.productUnits) / 1e6
      const movement = row.price * productAmount
      const inserted = yield* withTransaction(async (dbTx) => {
        const ledger = await dbTx
          .insert(transactions)
          .values({
            address: tx.payer,
            amount: direction === 'deposit' ? productAmount : -productAmount,
            cost: movement,
            date: tx.blockTime ?? new Date(),
            movement: direction === 'deposit' ? movement : -movement,
            signature: `${signature}:${row.delta.mint}`,
            token: row.symbol,
            type: direction === 'deposit' ? ('deposit' as const) : ('withdrawal' as const),
            userId: member.id,
          })
          .returning()
        await dbTx
          .update(wrappedClaims)
          .set({ state: 'recorded', updatedAt: new Date() })
          .where(and(eq(wrappedClaims.signature, signature), eq(wrappedClaims.mint, row.delta.mint)))
        return ledger
      })
      custodialSignature = row.custodialSignature ?? custodialSignature
      rows.push(...inserted)
    }
    if (!rows.length) return yield* Effect.fail(insertFailed())
    return { custodialSignature, transactions: rows }
  })
}

// ─── On-chain tx reader ─────────────────────────────────────────────────────
// Helius calls are proxied here so the API key(s) stay server-side. Labels let
// the UI render "Tontine", "FiMs Treasury", member names or CEX labels instead
// of raw addresses.

const FIMS_TREASURY_ADDRESS = '58kZBjjtHShTtXFmygr3ZT8VSU4dH28PanRAdouHbToh'
const CHAIN_ADDRESS_MAX = 200

interface ChainLabelRow {
  address: string
  kind: 'cex' | 'member' | 'other' | 'tontine' | 'treasury'
  label: string
}

// Every address the reader can name, in precedence order: built-ins first,
// then the caller's OWN address-book entries, then members. Non-public
// members are only named for themselves and admins — a private member's
// wallets and name never leak through labels. Address-book entries stay
// private to their owner: another member's labels can neither leak their
// book nor let a member stamp a spoofed name onto shared history.
async function loadChainLabels(db: Db, signer: Option.Option<string>) {
  const signerAddress = Option.getOrNull(signer)
  const memberVisible = (() => {
    if (!signerAddress) return eq(users.isPublic, true)
    if (isAdminAddress(signerAddress)) return undefined
    return or(eq(users.isPublic, true), addressLinkedToUser(signerAddress))
  })()
  const ownBook =
    signerAddress === null
      ? sql`false`
      : isAdminAddress(signerAddress)
        ? undefined
        : sql`${addressBook.userId} in (select id from ${users} where ${addressLinkedToUser(signerAddress)})`
  const [memberRows, aliasRows, bookRows, tokenRows] = await Promise.all([
    db.select({ address: users.address, name: users.name }).from(users).where(memberVisible),
    db
      .select({ address: userAddresses.address, name: users.name })
      .from(userAddresses)
      .innerJoin(users, eq(userAddresses.userId, users.id))
      .where(memberVisible),
    db
      .select({ address: addressBook.address, label: addressBook.label, type: addressBook.type })
      .from(addressBook)
      .where(ownBook),
    db.select({ address: tokens.address, symbol: tokens.symbol }).from(tokens),
  ])

  const labels = new Map<string, { kind: ChainLabelRow['kind']; label: string }>()
  labels.set(FIMS_TREASURY_ADDRESS, { kind: 'treasury', label: 'FiMs Treasury' })
  labels.set(FIMS_TONTINE_ADDRESS, { kind: 'tontine', label: 'Tontine' })
  const put = (address: string, kind: ChainLabelRow['kind'], label: string) => {
    if (!labels.has(address)) labels.set(address, { kind, label })
  }
  for (const row of bookRows) {
    put(row.address, row.type === 'other' ? 'other' : 'cex', row.label || row.type)
  }
  for (const row of memberRows) put(row.address, 'member', row.name)
  for (const row of aliasRows) put(row.address, 'member', row.name)

  const symbols = new Map<string, string>()
  for (const row of tokenRows) {
    if (row.address) symbols.set(row.address, row.symbol)
  }

  const rows: ChainLabelRow[] = [...labels.entries()].map(([address, { kind, label }]) => ({
    address,
    kind,
    label,
  }))
  return { labels, rows, symbols }
}

// Upstream failures never reach the client verbatim — an RPC error body or
// a fetch error can embed the endpoint URL (and its ?api-key). Detail stays
// in the server logs; the member gets a generic, retryable reason.
const chainUnavailable = (cause: unknown) => {
  console.error('chain provider failure', cause)
  return new ChainUnavailable({ reason: 'chain provider temporarily unavailable — retry shortly' })
}

// The chain reader proxies PAID Helius calls — an abused wallet key must not
// be able to burn the shared provider budget. Per-signer bucket over the
// rate_limits retention window (rows purge after ~10 min); generous enough
// for normal browsing, hard against scripted scraping.
const CHAIN_READS_PER_WINDOW = 60
const consumeChainQuota = (signer: string) =>
  Effect.gen(function* () {
    const { db } = yield* DatabaseService
    const windowStart = new Date(Math.floor(Date.now() / (10 * 60 * 1000)) * 10 * 60 * 1000)
    const result = yield* Effect.tryPromise({
      catch: () => new RateLimited({ reason: 'rate limiter unavailable' }),
      try: () =>
        db.execute(sql`
          INSERT INTO rate_limits (bucket, window_start, count)
          VALUES (${`chain:${signer}`}, ${windowStart.toISOString()}, 1)
          ON CONFLICT (bucket, window_start) DO UPDATE SET count = rate_limits.count + 1
          RETURNING count
        `),
    })
    const count = Number((result as unknown as { rows?: { count: number }[] }).rows?.[0]?.count ?? 0)
    if (count > CHAIN_READS_PER_WINDOW) {
      return yield* Effect.fail(
        new RateLimited({ reason: `chain read quota exceeded (${CHAIN_READS_PER_WINDOW} per 10 minutes)` }),
      )
    }
  })

const heliusKeysOrFail = Effect.gen(function* () {
  const keys = heliusApiKeys()
  if (!keys.length) return yield* Effect.fail(new ChainUnavailable({ reason: 'HELIUS_API_KEY is not configured' }))
  return keys
})
