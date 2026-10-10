import { and, asc, desc, eq, or, sql } from 'drizzle-orm'
import { Effect, Option } from 'effect'
import {
  addressBook,
  adminAuditLog,
  fimsSettings,
  transactions,
  userAddresses,
  users,
  voteBallots,
  voteOptions,
  votes,
} from '../../db/schema.js'
import { DatabaseError, type DatabaseNotConfigured, type DatabaseService, withDb } from '../../db/service.js'
import { envFloat } from '../../env.js'
import { AuthForbidden, isAdminAddress, requireNotDemo } from '../../services/auth/service.js'
import { BadRequest, RateLimited } from './api.js'

export const notFound = (what: string) => `not found: ${what}`
export const insertFailed = () => new DatabaseError({ cause: 'insert returned no row' })

// All list reads are bounded: a single unbounded query would scan a whole
// table (Neon cost) and produce oversized responses.
export const DEFAULT_PAGE_SIZE = 500
export const MAX_PAGE_SIZE = 2000

export const pageParams = ({ limit, offset }: { limit?: number | undefined; offset?: number | undefined }) => ({
  limit: Math.min(Math.max(1, Math.floor(limit ?? DEFAULT_PAGE_SIZE)), MAX_PAGE_SIZE),
  offset: Math.max(0, Math.floor(offset ?? 0)),
})

export interface UserAccess {
  address: string
  isPublic: boolean
}

// An address reaches a member either as users.address (canonical) or through
// a user_addresses alias — every member resolution must go through this so a
// linked wallet inherits the member's visibility and write rights.
export const addressLinkedToUser = (address: string) =>
  or(
    eq(users.address, address),
    sql`${users.id} in (select ${userAddresses.userId} from ${userAddresses} where ${userAddresses.address} = ${address})`,
  )

// Like requireOwnerOrAdmin but for multi-wallet members: any address linked
// to the user (canonical or alias) signs with equal rights. Also yields the
// 404 the previous ownerAddressOfUser lookup produced.
export const requireLinkedOrAdmin = (signer: string, userId: number) =>
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
export const requireCanonicalOrAdmin = (signer: string, userId: number) =>
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
export const requireMember = (
  signer: string,
): Effect.Effect<typeof users.$inferSelect, BadRequest | DatabaseError | DatabaseNotConfigured, DatabaseService> =>
  Effect.gen(function* () {
    const memberRows = yield* withDb((db) => db.select().from(users).where(addressLinkedToUser(signer)))
    const member = memberRows[0]
    if (!member) return yield* Effect.fail(new BadRequest({ reason: 'signer is not a FiMs member' }))
    return member
  })

// Public-facing display name: NFKC + whitespace collapse so "Flo", "flo "
// and homoglyph lookalikes cannot squat one another. Uniqueness below is
// case-insensitive on top of this.
export const normalizeName = (name: string) => name.normalize('NFKC').replace(/\s+/g, ' ').trim()

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
export const visibilityFilter = (signer: Option.Option<string>) =>
  Option.match(signer, {
    onNone: () => eq(users.isPublic, true),
    onSome: (s) => (isAdminAddress(s) ? undefined : or(eq(users.isPublic, true), addressLinkedToUser(s))),
  })

export const userAccessOfId = (userId: number) =>
  withDb((db) =>
    db.select({ address: users.address, isPublic: users.isPublic }).from(users).where(eq(users.id, userId)),
  ).pipe(
    Effect.flatMap((rows) => (rows[0] ? Effect.succeed<UserAccess>(rows[0]) : Effect.fail(notFound(`user ${userId}`)))),
  )

export const PROFILE_EDIT_COOLDOWN_MS = 24 * 60 * 60 * 1000

// Members may edit their own profile (name/privacy) at most once a day — the
// name is displayed publicly and flipping it constantly would confuse the
// community views. Admin edits bypass the cooldown entirely.
export const memberProfileEditAllowed = (userId: number) =>
  withDb((db) => db.select({ profileUpdatedAt: users.profileUpdatedAt }).from(users).where(eq(users.id, userId))).pipe(
    Effect.flatMap((rows) => {
      const last = rows[0]?.profileUpdatedAt
      return last && Date.now() - last.getTime() < PROFILE_EDIT_COOLDOWN_MS
        ? Effect.fail(new RateLimited({ reason: `profile already edited ${last.toISOString()}` }))
        : Effect.void
    }),
  )

export const ownerUserIdOfAddressBookEntry = (id: number) =>
  withDb((db) => db.select({ userId: addressBook.userId }).from(addressBook).where(eq(addressBook.id, id))).pipe(
    Effect.flatMap((rows) =>
      rows[0] ? Effect.succeed(rows[0].userId) : Effect.fail(notFound(`address book entry ${id}`)),
    ),
  )

// Transactions with userId = null are admin-only (empty owner never matches a signer)
export const ownerAddressOfTransaction = (id: number) =>
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
export const loadVoteWeights = Effect.gen(function* () {
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
export const PROPOSAL_THRESHOLD_KEY = 'proposal_threshold'
export const DEFAULT_PROPOSAL_THRESHOLD = 0.01

export const loadFimsConfig = Effect.gen(function* () {
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

export const loadVotesWithResults = (signer: Option.Option<string>) =>
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
export const PRICE_STALE_MS = 10 * 60 * 1000

// Wrapped-product circuit breakers (see wrappedTransfer): the operator price
// may not jump more than this fraction away from the last ledger-implied
// price, and rolling-24h caps bound mint+redeem volume in product units —
// per member and globally. All overridable via env for ops tuning.
// Parsed via envFloat: a malformed override throws (fail closed) rather than
// producing NaN — every NaN comparison is false, which would silently disable
// the breaker and both caps.
export const wrappedPriceBreaker = () => envFloat('FIMS_WRAPPED_PRICE_BREAKER', 0.1)
export const wrappedDailyCap = (scope: 'global' | 'member') =>
  envFloat(
    scope === 'member' ? 'FIMS_WRAPPED_MEMBER_DAILY_UNITS' : 'FIMS_WRAPPED_GLOBAL_DAILY_UNITS',
    scope === 'member' ? 10_000 : 50_000,
  )
// Bounds what a stolen member key can bleed through back-and-forth
// conversions (each round-trip burns the fee). Generous enough to never
// block a legitimate rebalance.
export const MAX_DAILY_CONVERT_EUR = 250_000

// Append-only record of ledger mutations — every signer, not just admins:
// a compromised member key must be reconstructible too. `admin_address`
// holds the acting signer (the column name is historical).
export const auditAdmin = (signer: string, action: string, resourceId: string, detail?: unknown) =>
  withDb((db) =>
    db.insert(adminAuditLog).values({
      action,
      adminAddress: signer,
      detail: detail === undefined ? null : JSON.stringify(detail).slice(0, 2000),
      resourceId,
    }),
  )

export const deriveTransactionType = (
  movement: number,
  cost: number,
  counterpartyIsCex = false,
): 'cex_in' | 'cex_out' | 'deposit' | 'donation' | 'payment' | 'withdrawal' => {
  if (counterpartyIsCex) return movement > 0 ? 'cex_in' : 'cex_out'
  const special = Math.abs(movement - cost) < 0.01
  return movement > 0 ? (special ? 'donation' : 'deposit') : special ? 'payment' : 'withdrawal'
}
