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
    amount: numeric('amount', { mode: 'number' }),
    cost: numeric('cost', { mode: 'number' }).notNull().default(0),
    createdAt: timestamp('created_at', { mode: 'date' }).notNull().defaultNow(),
    date: timestamp('date', { mode: 'date' }).notNull(),
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

export const votes = pgTable('votes', {
  closesAt: timestamp('closes_at', { mode: 'date' }),
  createdAt: timestamp('created_at', { mode: 'date' }).notNull().defaultNow(),
  description: text('description'),
  id: serial('id').primaryKey(),
  kind: voteKind('kind').notNull().default('investment'),
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
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    voteId: integer('vote_id')
      .notNull()
      .references(() => votes.id, { onDelete: 'cascade' }),
  },
  (t) => [primaryKey({ columns: [t.voteId, t.userId] })],
)
