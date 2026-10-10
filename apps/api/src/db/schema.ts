import {
  boolean,
  integer,
  numeric,
  pgEnum,
  pgTable,
  // biome-ignore lint/suspicious/noDeprecatedImports: only the variadic signature is deprecated, primaryKey({ columns }) is the current API
  primaryKey,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core'

export const transactionType = pgEnum('transaction_type', [
  'deposit',
  'withdrawal',
  'donation',
  'payment',
  'tontine',
  'conversion',
  'cex_in',
  'cex_out',
])

export const addressBookType = pgEnum('address_book_type', ['nexo', 'coinbase', 'binance', 'fimseur', 'other'])

export const voteStatus = pgEnum('vote_status', ['draft', 'open', 'closed'])

// Vote kind decides the ballot weight: a tontine vote weights members by
// their tontine transfers, an investment vote by their invested amount.
export const voteKind = pgEnum('vote_kind', ['investment', 'tontine'])

export const users = pgTable('users', {
  // One row per wallet — duplicate addresses would break member resolution and
  // allow address squatting (a squatter's address book could poison the
  // victim's send-destination suggestions).
  address: text('address').notNull().unique(),
  createdAt: timestamp('created_at', { mode: 'date' }).notNull().defaultNow(),
  id: serial('id').primaryKey(),
  isPro: boolean('is_pro').notNull().default(false),
  isPublic: boolean('is_public').notNull().default(false),
  name: text('name').notNull().unique(),
  // Last member-initiated profile edit (name/privacy). Admin corrections do not
  // touch this — the once-a-day limit only applies to self-service edits.
  profileUpdatedAt: timestamp('profile_updated_at', { mode: 'date' }),
  // Member-chosen rebalance target: share of the portfolio kept in risky assets
  // (0–100). Null = no target set, no drift check.
  riskTarget: numeric('risk_target', { mode: 'number' }),
  updatedAt: timestamp('updated_at', { mode: 'date' }).notNull().defaultNow(),
})

// Extra wallet addresses linked to a member — one user, several wallets.
// users.address stays the canonical (primary) address; rows here are the
// additional ones. Linking requires a signature from an already-linked
// address plus the new address's own consent signature, so a squatter
// cannot attach a foreign key and an outsider cannot self-attach.
export const userAddresses = pgTable('user_addresses', {
  address: text('address').notNull().unique(),
  createdAt: timestamp('created_at', { mode: 'date' }).notNull().defaultNow(),
  id: serial('id').primaryKey(),
  userId: integer('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
})

export const tokens = pgTable('tokens', {
  address: text('address'),
  description: text('description'),
  duration: numeric('duration', { mode: 'number' }),
  inceptionPrice: numeric('inception_price', { mode: 'number' }),
  inceptionRatio: numeric('inception_ratio', { mode: 'number' }),
  label: text('label').notNull(),
  symbol: text('symbol').primaryKey(),
  updatedAt: timestamp('updated_at', { mode: 'date' }).notNull().defaultNow(),
  value: numeric('value', { mode: 'number' }),
  volatility: numeric('volatility', { mode: 'number' }),
  yearlyYield: numeric('yearly_yield', { mode: 'number' }),
})

export const transactions = pgTable(
  'transactions',
  {
    address: text('address').notNull(),
    // Token units, stored/read as an exact decimal string — float64 would
    // drift the on-chain reconciliation invariant over enough decimals.
    amount: numeric('amount', { mode: 'string' }),
    cost: numeric('cost', { mode: 'number' }).notNull().default(0),
    createdAt: timestamp('created_at', { mode: 'date' }).notNull().defaultNow(),
    date: timestamp('date', { mode: 'date' }).notNull(),
    // Token units gifted to donation_target ON TOP of `amount` (same token):
    // an extra outflow from the member's position toward the target, priced
    // at the row's implied rate |movement + cost| / |amount|. Lets one row
    // carry e.g. a withdrawal + its tontine share + an operating fee (cost).
    // Outflow rows only (amount < 0). Pure donations keep it NULL — their
    // whole amount is already the gift.
    donationAmount: numeric('donation_amount', { mode: 'string' }),
    donationTarget: text('donation_target'),
    id: serial('id').primaryKey(),
    movement: numeric('movement', { mode: 'number' }).notNull().default(0),
    // Client-generated idempotency key for member-initiated operations
    // (conversions): a retried submission is deduplicated instead of
    // double-applying. NULL rows (ETL writes) never collide — unique()
    // treats nulls as distinct.
    requestId: text('request_id'),
    signature: text('signature'),
    token: text('token'),
    type: transactionType('type'),
    userId: integer('user_id').references(() => users.id, { onDelete: 'set null' }),
  },
  (t) => [uniqueIndex('transactions_user_request_uniq').on(t.userId, t.requestId)],
)

// Replay lock for signed requests: every accepted signature on a mutating
// request is recorded here, so the same signed request cannot be applied
// twice inside its 5-minute validity window.
export const usedSignatures = pgTable('used_signatures', {
  createdAt: timestamp('created_at', { mode: 'date' }).notNull().defaultNow(),
  signature: text('signature').primaryKey(),
})

// Bearer sessions: minted by one SIWS signature (POST /fims/session), then
// carried as `Authorization: Bearer` instead of a per-request signature.
// Only sha256(token) is stored — a DB dump never leaks a usable token.
// Sensitive mutations still require a fresh x-fims-confirm-* signature on
// top of the session.
export const fimsSessions = pgTable('fims_sessions', {
  address: text('address').notNull(),
  createdAt: timestamp('created_at', { mode: 'date' }).notNull().defaultNow(),
  expiresAt: timestamp('expires_at', { mode: 'date' }).notNull(),
  lastSeenAt: timestamp('last_seen_at', { mode: 'date' }),
  tokenHash: text('token_hash').primaryKey(),
})

// Wrapped mint/redeem state machine — the pipeline is three commits (claim →
// custodial mint → ledger row) that cannot be atomic, so progress is durable:
// 'claimed' = slot reserved (a crashed mint leaves this stuck and blocks —
// admin deletes the row to unblock, after checking the chain for a landed
// custodial tx; ONLY 'claimed' rows may be deleted — deleting a 'minted' row
// would re-run a payout that already landed), 'minted' = on-chain step done,
// ledger replayable without re-minting, 'recorded' = ledger row written
// (terminal). 'abandoned' = payer no longer resolves to a member (terminal,
// admin-visible).
export const wrappedClaims = pgTable(
  'wrapped_claims',
  {
    createdAt: timestamp('created_at', { mode: 'date' }).notNull().defaultNow(),
    custodialSignature: text('custodial_signature'),
    mint: text('mint').notNull(),
    // Committed volume for the rolling-24h caps — queued/claimed/minted
    // legs have no ledger row yet, so without these columns a member could
    // queue cap-max redeems back-to-back and blow the daily limits.
    productUnits: numeric('product_units', { mode: 'string' }),
    signature: text('signature').notNull(),
    state: text('state').notNull(),
    updatedAt: timestamp('updated_at', { mode: 'date' }).notNull().defaultNow(),
    userId: integer('user_id').references(() => users.id, { onDelete: 'set null' }),
  },
  (t) => [primaryKey({ columns: [t.signature, t.mint] })],
)

// Shared rate-limit counters: fixed-window hits per bucket ('mut:<ip>' or
// 'read:<ip>'). Per-instance memory buckets (index.ts) cannot see other
// serverless isolates — this table is the enforcement that survives
// horizontal scaling. Rows older than a few minutes are dead weight and
// purged opportunistically by the writer.
export const rateLimits = pgTable(
  'rate_limits',
  {
    bucket: text('bucket').notNull(),
    count: integer('count').notNull().default(0),
    windowStart: timestamp('window_start', { mode: 'date' }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.bucket, t.windowStart] })],
)

// Append-only trail of privileged actions. Only rows where an admin acted
// on a resource they do not own land here — the ledger money moves through
// these endpoints, so every admin write must be reconstructible.
export const adminAuditLog = pgTable('admin_audit_log', {
  action: text('action').notNull(),
  adminAddress: text('admin_address').notNull(),
  createdAt: timestamp('created_at', { mode: 'date' }).notNull().defaultNow(),
  detail: text('detail'),
  id: serial('id').primaryKey(),
  resourceId: text('resource_id'),
})

export const dashboardMetrics = pgTable('dashboard_metrics', {
  label: text('label').primaryKey(),
  ratio: numeric('ratio', { mode: 'number' }),
  value: numeric('value', { mode: 'number' }).notNull(),
})

export const historic = pgTable('historic', {
  date: timestamp('date', { mode: 'date' }).primaryKey(),
  invested: numeric('invested', { mode: 'number' }).notNull(),
  treasury: numeric('treasury', { mode: 'number' }),
})

export const userHistoric = pgTable(
  'user_historic',
  {
    date: timestamp('date', { mode: 'date' }).notNull(),
    invested: numeric('invested', { mode: 'number' }).notNull(),
    total: numeric('total', { mode: 'number' }),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
  },
  (t) => [primaryKey({ columns: [t.userId, t.date] })],
)

export const prices = pgTable(
  'prices',
  {
    date: timestamp('date', { mode: 'date' }).notNull(),
    price: numeric('price', { mode: 'number' }).notNull(),
    token: text('token').notNull(),
  },
  (t) => [primaryKey({ columns: [t.token, t.date] })],
)

export const addressBook = pgTable('address_book', {
  address: text('address').notNull(),
  createdAt: timestamp('created_at', { mode: 'date' }).notNull().defaultNow(),
  id: serial('id').primaryKey(),
  label: text('label').notNull(),
  type: addressBookType('type').notNull().default('other'),
  userId: integer('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
})

// Key-value config the admin can tune without a deploy. Only key today:
// 'proposal_threshold' — share of total invested assets a member must exceed
// to submit a tontine proposal (default '0.01' = 1%).
export const fimsSettings = pgTable('fims_settings', {
  key: text('key').primaryKey(),
  updatedAt: timestamp('updated_at', { mode: 'date' }).notNull().defaultNow(),
  value: text('value').notNull(),
})

export const votes = pgTable('votes', {
  closesAt: timestamp('closes_at', { mode: 'date' }),
  createdAt: timestamp('created_at', { mode: 'date' }).notNull().defaultNow(),
  description: text('description'),
  id: serial('id').primaryKey(),
  kind: voteKind('kind').notNull().default('investment'),
  // Member who proposed the vote — null for admin-created votes. Proposals
  // land as drafts until an admin opens them.
  proposerId: integer('proposer_id').references(() => users.id, { onDelete: 'set null' }),
  status: voteStatus('status').notNull().default('draft'),
  title: text('title').notNull(),
})

export const voteOptions = pgTable('vote_options', {
  id: serial('id').primaryKey(),
  label: text('label').notNull(),
  sortOrder: integer('sort_order').notNull().default(0),
  voteId: integer('vote_id')
    .notNull()
    .references(() => votes.id, { onDelete: 'cascade' }),
})

export const voteBallots = pgTable(
  'vote_ballots',
  {
    createdAt: timestamp('created_at', { mode: 'date' }).notNull().defaultNow(),
    optionId: integer('option_id')
      .notNull()
      .references(() => voteOptions.id, { onDelete: 'cascade' }),
    // Last change timestamp — a ballot may only be updated once per 24 h.
    updatedAt: timestamp('updated_at', { mode: 'date' }).notNull().defaultNow(),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    voteId: integer('vote_id')
      .notNull()
      .references(() => votes.id, { onDelete: 'cascade' }),
  },
  (t) => [primaryKey({ columns: [t.voteId, t.userId] })],
)

// TTL lease for the keeper: the 1-minute cron can overlap a slow pass (a
// full placement takes longer than a minute), and neon-http cannot hold a
// session-level advisory lock. Atomic compare-and-set: a pass only wins the
// lease when the previous one expired — a crashed holder self-heals by TTL.
export const keeperLocks = pgTable('keeper_locks', {
  expiresAt: timestamp('expires_at', { mode: 'date' }).notNull(),
  name: text('name').primaryKey(),
  owner: text('owner'),
})

// Keeper audit trail: one row per on-chain member_deposit PDA. The delegate
// records share issuance (1:1 vs deposited collateral) and the placement
// pipeline signatures so a failed pass is retried and reconstructible.
export const strategyOps = pgTable('strategy_ops', {
  collateralAmount: text('collateral_amount').notNull(),
  depositPda: text('deposit_pda').primaryKey(),
  error: text('error'),
  firstSeenAt: timestamp('first_seen_at', { mode: 'date' }).notNull().defaultNow(),
  issueSignature: text('issue_signature'),
  member: text('member').notNull(),
  opsSignature: text('ops_signature'),
  status: text('status').notNull(), // pending | issued | placed | failed
  strategyIndex: integer('strategy_index').notNull(),
  updatedAt: timestamp('updated_at', { mode: 'date' }).notNull().defaultNow(),
})
