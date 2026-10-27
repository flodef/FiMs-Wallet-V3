import { Schema } from 'effect'

// Request/response schemas for the FiMs API — the wire contract shared by
// handlers and clients. Endpoint definitions live in api.ts.
export const TransactionType = Schema.Literal(
  'deposit',
  'withdrawal',
  'donation',
  'payment',
  'tontine',
  'conversion',
  'cex_in',
  'cex_out',
)

export class User extends Schema.Class<User>('User')({
  address: Schema.String,
  // Canonical + linked wallet addresses — only present on the list endpoint.
  addresses: Schema.optional(Schema.Array(Schema.String)),
  createdAt: Schema.Date,
  id: Schema.Number,
  isPro: Schema.Boolean,
  isPublic: Schema.Boolean,
  name: Schema.String,
  profileUpdatedAt: Schema.NullOr(Schema.Date),
  riskTarget: Schema.NullOr(Schema.Number),
  updatedAt: Schema.Date,
}) {}

// Extra wallet linked to a member (multi-wallet: one user, several wallets).
export class UserAddress extends Schema.Class<UserAddress>('UserAddress')({
  address: Schema.String,
  createdAt: Schema.Date,
  id: Schema.Number,
  userId: Schema.Number,
}) {}

export class Transaction extends Schema.Class<Transaction>('Transaction')({
  address: Schema.String,
  amount: Schema.NullOr(Schema.String),
  cost: Schema.Number,
  createdAt: Schema.Date,
  date: Schema.Date,
  donationAmount: Schema.NullOr(Schema.String),
  donationTarget: Schema.NullOr(Schema.String),
  id: Schema.Number,
  movement: Schema.Number,
  signature: Schema.NullOr(Schema.String),
  token: Schema.NullOr(Schema.String),
  type: Schema.NullOr(TransactionType),
  userId: Schema.NullOr(Schema.Number),
}) {}

export class Token extends Schema.Class<Token>('Token')({
  address: Schema.NullOr(Schema.String),
  description: Schema.NullOr(Schema.String),
  duration: Schema.NullOr(Schema.Number),
  inceptionPrice: Schema.NullOr(Schema.Number),
  inceptionRatio: Schema.NullOr(Schema.Number),
  label: Schema.String,
  symbol: Schema.String,
  updatedAt: Schema.Date,
  value: Schema.NullOr(Schema.Number),
  volatility: Schema.NullOr(Schema.Number),
  yearlyYield: Schema.NullOr(Schema.Number),
}) {}

export class HistoricPoint extends Schema.Class<HistoricPoint>('HistoricPoint')({
  date: Schema.Date,
  invested: Schema.Number,
  treasury: Schema.NullOr(Schema.Number),
}) {}

export class UserHistoricPoint extends Schema.Class<UserHistoricPoint>('UserHistoricPoint')({
  date: Schema.Date,
  invested: Schema.Number,
  total: Schema.NullOr(Schema.Number),
  userId: Schema.Number,
}) {}

// Member portfolio summary recomputed from the `transactions` ledger (see
// member-stats.ts) — the same indicators the legacy spreadsheet produced.
export class MemberSummary extends Schema.Class<MemberSummary>('MemberSummary')({
  donated: Schema.Number,
  durationDays: Schema.NullOr(Schema.Number),
  grossDeposits: Schema.Number,
  invested: Schema.Number,
  positions: Schema.Array(
    Schema.Struct({
      price: Schema.NullOr(Schema.Number),
      symbol: Schema.String,
      units: Schema.Number,
      value: Schema.Number,
    }),
  ),
  profit: Schema.Number,
  profitRatio: Schema.NullOr(Schema.Number),
  total: Schema.Number,
  yearlyRate: Schema.NullOr(Schema.Number),
}) {}

export class PricePoint extends Schema.Class<PricePoint>('PricePoint')({
  date: Schema.Date,
  price: Schema.Number,
  token: Schema.String,
}) {}

export class DashboardMetric extends Schema.Class<DashboardMetric>('DashboardMetric')({
  label: Schema.String,
  ratio: Schema.NullOr(Schema.Number),
  value: Schema.Number,
}) {}

export const AddressBookType = Schema.Literal('nexo', 'coinbase', 'binance', 'fimseur', 'other')

export class AddressBookEntry extends Schema.Class<AddressBookEntry>('AddressBookEntry')({
  address: Schema.String,
  createdAt: Schema.Date,
  id: Schema.Number,
  label: Schema.String,
  type: AddressBookType,
  userId: Schema.Number,
}) {}

// Base58-encoded Solana public key (32 bytes → 32-44 chars, no 0/O/I/l).
export const SolanaAddress = Schema.String.pipe(Schema.pattern(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/))

export const CreateAddressBookEntryBody = Schema.Struct({
  address: SolanaAddress,
  label: Schema.String,
  type: Schema.optional(AddressBookType),
  userId: Schema.Number,
})

export const UpdateAddressBookEntryBody = Schema.Struct({
  address: Schema.optional(SolanaAddress),
  label: Schema.optional(Schema.String),
  type: Schema.optional(AddressBookType),
})

export const NotFound = Schema.String

// Tagged errors for non-404 failures — plain Schema.String errors on the same
// endpoint would be ambiguous for the error-to-status mapping.
export class BadRequest extends Schema.TaggedError<BadRequest>()('BadRequest', {
  reason: Schema.String,
}) {}
export class RateLimited extends Schema.TaggedError<RateLimited>()('RateLimited', {
  reason: Schema.String,
}) {}
export class CustodialUnavailable extends Schema.TaggedError<CustodialUnavailable>()('CustodialUnavailable', {
  reason: Schema.String,
}) {}
export class ChainUnavailable extends Schema.TaggedError<ChainUnavailable>()('ChainUnavailable', {
  reason: Schema.String,
}) {}

// Strategy delegate (keeper) payloads — the cron-driven automation that turns
// member_deposit records into issued shares + placed collateral. Gated by a
// shared secret header, not a wallet signature: the caller is cron-job.org.
export class StrategyHealth extends Schema.Class<StrategyHealth>('StrategyHealth')({
  delegate: Schema.optional(Schema.String),
  delegateLamports: Schema.optional(Schema.Number),
  failedOps: Schema.Number,
  healthy: Schema.Boolean,
  issues: Schema.Array(Schema.String),
  pendingDeposits: Schema.Number,
  staleDeposits: Schema.Number,
}) {}

export class DelegateDepositReport extends Schema.Class<DelegateDepositReport>('DelegateDepositReport')({
  error: Schema.optional(Schema.String),
  issueSignature: Schema.optional(Schema.String),
  member: Schema.String,
  opsSignatures: Schema.optional(Schema.Array(Schema.String)),
  pending: Schema.String,
  strategy: Schema.Number,
}) {}

export class DelegateRunReport extends Schema.Class<DelegateRunReport>('DelegateRunReport')({
  deposits: Schema.Array(DelegateDepositReport),
  skipped: Schema.optional(Schema.String),
}) {}

// Custodial keeper payloads. Bigints travel as base-unit strings.
export class CustodialSweepReport extends Schema.Class<CustodialSweepReport>('CustodialSweepReport')({
  product: Schema.String,
  signature: Schema.NullOr(Schema.String),
  swept: Schema.String,
}) {}

export class CustodialBackingRow extends Schema.Class<CustodialBackingRow>('CustodialBackingRow')({
  backingTotal: Schema.String,
  float: Schema.String,
  floatTarget: Schema.String,
  healthy: Schema.Boolean,
  product: Schema.String,
  supply: Schema.String,
  vault: Schema.String,
}) {}

export class CustodialBackingStatus extends Schema.Class<CustodialBackingStatus>('CustodialBackingStatus')({
  products: Schema.Array(CustodialBackingRow),
}) {}

// On-chain tx reader payloads — the API proxies Helius (the key stays
// server-side) and returns this normalized shape so the UI is decoupled from
// the upstream schema.
export class ChainTransfer extends Schema.Class<ChainTransfer>('ChainTransfer')({
  amount: Schema.Number,
  counterparty: Schema.NullOr(Schema.String),
  counterpartyLabel: Schema.NullOr(Schema.String),
  direction: Schema.Literal('in', 'out'),
  // null mint = native SOL.
  mint: Schema.NullOr(Schema.String),
  symbol: Schema.NullOr(Schema.String),
}) {}

export class ChainTransaction extends Schema.Class<ChainTransaction>('ChainTransaction')({
  description: Schema.String,
  feeSol: Schema.Number,
  signature: Schema.String,
  source: Schema.NullOr(Schema.String),
  // Unix seconds — Helius returns a number, not an ISO date.
  timestamp: Schema.Number,
  transfers: Schema.Array(ChainTransfer),
  type: Schema.String,
}) {}

export class ChainLabel extends Schema.Class<ChainLabel>('ChainLabel')({
  address: Schema.String,
  kind: Schema.Literal('cex', 'member', 'other', 'tontine', 'treasury'),
  label: Schema.String,
}) {}

export class ChainAsset extends Schema.Class<ChainAsset>('ChainAsset')({
  amount: Schema.Number,
  mint: Schema.NullOr(Schema.String),
  name: Schema.NullOr(Schema.String),
  symbol: Schema.NullOr(Schema.String),
  usdPrice: Schema.NullOr(Schema.Number),
}) {}

export class ChainHistoryPage extends Schema.Class<ChainHistoryPage>('ChainHistoryPage')({
  // Opaque provider cursor — pass back verbatim for the next page, null at end.
  cursor: Schema.NullOr(Schema.String),
  transactions: Schema.Array(ChainTransaction),
}) {}

// Public-facing member identity is bounded: unbounded/blank names allow
// squats and abuse; homoglyph normalization happens in the handler.
export const MemberName = Schema.String.pipe(Schema.minLength(1), Schema.maxLength(40))

export const CreateUserBody = Schema.Struct({
  address: SolanaAddress,
  isPublic: Schema.optional(Schema.Boolean),
  name: MemberName,
})

// `address` and `isPro` are privileged: the handler rejects them for non-admin
// signers (self-service is limited to name/isPublic).
export const UpdateUserBody = Schema.Struct({
  address: Schema.optional(SolanaAddress),
  isPro: Schema.optional(Schema.Boolean),
  isPublic: Schema.optional(Schema.Boolean),
  name: Schema.optional(MemberName),
  // Member's own rebalance target (% of risky assets). Preference, not
  // identity — exempt from the once-a-day profile-edit cooldown.
  riskTarget: Schema.optional(Schema.NullOr(Schema.Number.pipe(Schema.between(0, 100)))),
})

// `signature` is the new address's ed25519 consent over the canonical link
// message `fims-wallet-v3\nlink-address\n<userId>\n<address>` (base64). It is
// required for member-initiated links: the already-linked request signer
// alone cannot squat a foreign key. Admins may attach addresses without it.
export const LinkUserAddressBody = Schema.Struct({
  address: SolanaAddress,
  signature: Schema.optional(Schema.String),
  // Exact bytes the wallet signed — wallets may modify the consent message
  // (see CreateSessionBody.signedMessage).
  signedMessage: Schema.optional(Schema.String),
})

// Exact-decimal unit amounts travel as number or numeric string — a
// non-numeric string would pass validation then explode on the `numeric`
// column insert (500 instead of a clean 400).
export const TokenUnits = Schema.Union(
  Schema.Number.pipe(Schema.filter((n) => Number.isFinite(n), { message: () => 'expected a finite number' })),
  Schema.String.pipe(Schema.pattern(/^-?\d+(\.\d+)?$/)),
)

export const CreateTransactionBody = Schema.Struct({
  address: Schema.String,
  amount: Schema.optional(TokenUnits),
  cost: Schema.optional(Schema.Number),
  date: Schema.Date,
  donationAmount: Schema.optional(TokenUnits),
  donationTarget: Schema.optional(Schema.String),
  movement: Schema.Number,
  signature: Schema.optional(Schema.String),
  token: Schema.optional(Schema.String),
  type: Schema.optional(TransactionType),
  userId: Schema.Number,
})

// `userId` is intentionally absent: reassigning a transaction to another user
// would let a writer pollute someone else's history.
export const UpdateTransactionBody = Schema.Struct({
  address: Schema.optional(Schema.String),
  amount: Schema.optional(TokenUnits),
  cost: Schema.optional(Schema.Number),
  date: Schema.optional(Schema.Date),
  donationAmount: Schema.optional(TokenUnits),
  donationTarget: Schema.optional(Schema.String),
  movement: Schema.optional(Schema.Number),
  signature: Schema.optional(Schema.String),
  token: Schema.optional(Schema.String),
  type: Schema.optional(TransactionType),
})

// Pagination is bounded server-side: unbounded list reads would let a single
// request scan/return entire tables (Neon cost + oversized responses).
export const PaginationParams = {
  limit: Schema.optional(Schema.NumberFromString),
  offset: Schema.optional(Schema.NumberFromString),
}

export const VoteKind = Schema.Literal('investment', 'tontine')
export const VoteStatus = Schema.Literal('draft', 'open', 'closed')

export class VoteOption extends Schema.Class<VoteOption>('VoteOption')({
  ballots: Schema.Number,
  id: Schema.Number,
  label: Schema.String,
  sortOrder: Schema.Number,
  weight: Schema.Number,
}) {}

export class Vote extends Schema.Class<Vote>('Vote')({
  closesAt: Schema.NullOr(Schema.Date),
  createdAt: Schema.Date,
  description: Schema.NullOr(Schema.String),
  // Total voting weight available across all members for this vote kind
  // (all tontine contributions, or all invested amounts) — the denominator
  // of a member's voting power.
  eligibleWeight: Schema.Number,
  id: Schema.Number,
  kind: VoteKind,
  // When the signer's ballot was last cast/changed — the UI uses it to show
  // the 24 h cooldown before the decision can be changed again.
  myBallotUpdatedAt: Schema.NullOr(Schema.Date),
  myOptionId: Schema.NullOr(Schema.Number),
  // The signer's own voting weight for this vote kind. Null when unsigned.
  myWeight: Schema.NullOr(Schema.Number),
  options: Schema.Array(VoteOption),
  // Member who submitted the proposal (null for admin-created votes).
  proposerId: Schema.NullOr(Schema.Number),
  proposerName: Schema.NullOr(Schema.String),
  status: VoteStatus,
  title: Schema.String,
  totalWeight: Schema.Number,
}) {}

// Admin-tunable config surfaced to clients. `totalInvested` lets the client
// compute proposal eligibility locally (invested > threshold × total).
export class FimsConfig extends Schema.Class<FimsConfig>('FimsConfig')({
  proposalThreshold: Schema.Number,
  totalInvested: Schema.Number,
}) {}

export const UpdateConfigBody = Schema.Struct({
  proposalThreshold: Schema.Number.pipe(Schema.greaterThan(0), Schema.lessThanOrEqualTo(1)),
})

export const RecordDonationBody = Schema.Struct({
  signature: Schema.String.pipe(Schema.minLength(32), Schema.maxLength(128)),
})

// Vote fields are member-written public content — bound them server-side
// (unbounded strings are storage and rendering abuse, not just ugly).
export const ConvertPositionBody = Schema.Struct({
  eurAmount: Schema.Number.pipe(Schema.greaterThan(0)),
  fromToken: Schema.String,
  // Idempotency key the client generates per conversion intent:
  // retried submissions are deduplicated by (user_id, request_id)
  // instead of double-applying the ledger pair.
  requestId: Schema.String.pipe(Schema.minLength(8), Schema.maxLength(64)),
  toToken: Schema.String,
})

export const CreateVoteBody = Schema.Struct({
  closesAt: Schema.optional(Schema.Date),
  description: Schema.optional(Schema.String.pipe(Schema.maxLength(1000))),
  kind: VoteKind,
  options: Schema.Array(Schema.String.pipe(Schema.minLength(1), Schema.maxLength(80))).pipe(
    Schema.minItems(2),
    Schema.maxItems(16),
  ),
  title: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(80)),
})

export const UpdateVoteBody = Schema.Struct({
  status: VoteStatus,
})

// Ballot cast: the member signs `fims-wallet-v3\nvote\n{voteId}\n{optionId}\n
// {address}\n{ts}\n{nonce}` — a free message (no on-chain tx) verified
// server-side and replay-protected via used_signatures. `signedMessage`
// carries the exact bytes when the wallet wrapped them (see canonicalWithin).
export const CastBallotBody = Schema.Struct({
  nonce: Schema.String.pipe(Schema.minLength(8), Schema.maxLength(64)),
  optionId: Schema.Number,
  signature: Schema.String,
  signedMessage: Schema.optional(Schema.String),
  ts: Schema.Number,
})

export const WrappedTxBody = Schema.Struct({
  signature: Schema.String.pipe(Schema.minLength(32), Schema.maxLength(128)),
})

// SIWS sign-in: the server rebuilds the canonical message from these fields
// and verifies `signature` over it — the message text is never client-trusted.
// `signedMessage` carries the exact bytes the wallet signed when it modified
// them (wallet-standard signMessage may prepend its own preamble).
export const CreateSessionBody = Schema.Struct({
  address: SolanaAddress,
  issuedAt: Schema.String,
  nonce: Schema.String.pipe(Schema.minLength(16), Schema.maxLength(64)),
  signature: Schema.String,
  signedMessage: Schema.optional(Schema.String),
})

export class Session extends Schema.Class<Session>('Session')({
  expiresAt: Schema.Date,
  token: Schema.String,
}) {}

export class WrappedProduct extends Schema.Class<WrappedProduct>('WrappedProduct')({
  backingMint: Schema.String,
  id: Schema.String,
  mint: Schema.String,
  symbol: Schema.String,
}) {}

export class WrappedConfig extends Schema.Class<WrappedConfig>('WrappedConfig')({
  // Where deposits/redeems must be sent on-chain.
  custody: Schema.NullOr(Schema.String),
  products: Schema.Array(WrappedProduct),
}) {}

export class WrappedResult extends Schema.Class<WrappedResult>('WrappedResult')({
  // Signature of the custodial mint/burn transaction.
  custodialSignature: Schema.String,
  transactions: Schema.Array(Transaction),
}) {}
