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

export const users = pgTable('users', {
  // One row per wallet — duplicate addresses would break member resolution and
  // allow address squatting (a squatter's address book could poison the
  // victim's send-destination suggestions).
  address: text('address').notNull().unique(),
  createdAt: timestamp('created_at', { mode: 'date' }).notNull().defaultNow(),
  id: serial('id').primaryKey(),
  isPro: boolean('is_pro').notNull().default(false),
  isPublic: boolean('is_public').notNull().default(true),
  name: text('name').notNull().unique(),
  // Last member-initiated profile edit (name/privacy). Admin corrections do not
  // touch this — the once-a-day limit only applies to self-service edits.
  profileUpdatedAt: timestamp('profile_updated_at', { mode: 'date' }),
  updatedAt: timestamp('updated_at', { mode: 'date' }).notNull().defaultNow(),
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

export const transactions = pgTable('transactions', {
  address: text('address').notNull(),
  amount: numeric('amount', { mode: 'number' }),
  cost: numeric('cost', { mode: 'number' }).notNull().default(0),
  createdAt: timestamp('created_at', { mode: 'date' }).notNull().defaultNow(),
  date: timestamp('date', { mode: 'date' }).notNull(),
  donationTarget: text('donation_target'),
  id: serial('id').primaryKey(),
  movement: numeric('movement', { mode: 'number' }).notNull().default(0),
  signature: text('signature'),
  token: text('token'),
  type: transactionType('type'),
  userId: integer('user_id').references(() => users.id, { onDelete: 'set null' }),
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
