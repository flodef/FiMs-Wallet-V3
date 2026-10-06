import { HttpApiEndpoint, HttpApiGroup, OpenApi } from '@effect/platform'
import { Schema } from 'effect'
import { DatabaseError, DatabaseNotConfigured } from '../../db/service.js'
import { AuthForbidden, AuthUnauthorized } from '../../services/auth/service.js'

const TransactionType = Schema.Literal(
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
  amount: Schema.NullOr(Schema.Number),
  cost: Schema.Number,
  createdAt: Schema.Date,
  date: Schema.Date,
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

const CreateAddressBookEntryBody = Schema.Struct({
  address: SolanaAddress,
  label: Schema.String,
  type: Schema.optional(AddressBookType),
  userId: Schema.Number,
})

const UpdateAddressBookEntryBody = Schema.Struct({
  address: Schema.optional(SolanaAddress),
  label: Schema.optional(Schema.String),
  type: Schema.optional(AddressBookType),
})

const NotFound = Schema.String

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

const CreateUserBody = Schema.Struct({
  address: SolanaAddress,
  isPublic: Schema.optional(Schema.Boolean),
  name: Schema.String,
})

// `address` and `isPro` are privileged: the handler rejects them for non-admin
// signers (self-service is limited to name/isPublic).
const UpdateUserBody = Schema.Struct({
  address: Schema.optional(SolanaAddress),
  isPro: Schema.optional(Schema.Boolean),
  isPublic: Schema.optional(Schema.Boolean),
  name: Schema.optional(Schema.String),
  // Member's own rebalance target (% of risky assets). Preference, not
  // identity — exempt from the once-a-day profile-edit cooldown.
  riskTarget: Schema.optional(Schema.NullOr(Schema.Number.pipe(Schema.between(0, 100)))),
})

// `signature` is the new address's ed25519 consent over the canonical link
// message `fims-wallet-v3\nlink-address\n<userId>\n<address>` (base64). It is
// required for member-initiated links: the already-linked request signer
// alone cannot squat a foreign key. Admins may attach addresses without it.
const LinkUserAddressBody = Schema.Struct({
  address: SolanaAddress,
  signature: Schema.optional(Schema.String),
})

const CreateTransactionBody = Schema.Struct({
  address: Schema.String,
  amount: Schema.optional(Schema.Number),
  cost: Schema.optional(Schema.Number),
  date: Schema.Date,
  donationTarget: Schema.optional(Schema.String),
  movement: Schema.Number,
  signature: Schema.optional(Schema.String),
  token: Schema.optional(Schema.String),
  type: Schema.optional(TransactionType),
  userId: Schema.Number,
})

// `userId` is intentionally absent: reassigning a transaction to another user
// would let a writer pollute someone else's history.
const UpdateTransactionBody = Schema.Struct({
  address: Schema.optional(Schema.String),
  amount: Schema.optional(Schema.Number),
  cost: Schema.optional(Schema.Number),
  date: Schema.optional(Schema.Date),
  donationTarget: Schema.optional(Schema.String),
  movement: Schema.optional(Schema.Number),
  signature: Schema.optional(Schema.String),
  token: Schema.optional(Schema.String),
  type: Schema.optional(TransactionType),
})

// Pagination is bounded server-side: unbounded list reads would let a single
// request scan/return entire tables (Neon cost + oversized responses).
const PaginationParams = {
  limit: Schema.optional(Schema.NumberFromString),
  offset: Schema.optional(Schema.NumberFromString),
}

const VoteKind = Schema.Literal('investment', 'tontine')
const VoteStatus = Schema.Literal('draft', 'open', 'closed')

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

const UpdateConfigBody = Schema.Struct({
  proposalThreshold: Schema.Number.pipe(Schema.greaterThan(0), Schema.lessThanOrEqualTo(1)),
})

const RecordDonationBody = Schema.Struct({
  signature: Schema.String.pipe(Schema.minLength(32), Schema.maxLength(128)),
})

const CreateVoteBody = Schema.Struct({
  closesAt: Schema.optional(Schema.Date),
  description: Schema.optional(Schema.String),
  kind: VoteKind,
  options: Schema.Array(Schema.String).pipe(Schema.minItems(2)),
  title: Schema.String,
})

const UpdateVoteBody = Schema.Struct({
  status: VoteStatus,
})

const CastBallotBody = Schema.Struct({
  optionId: Schema.Number,
})

const WrappedTxBody = Schema.Struct({
  signature: Schema.String.pipe(Schema.minLength(32), Schema.maxLength(128)),
})

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

export class FimsApi extends HttpApiGroup.make('Fims')
  .add(
    HttpApiEndpoint.get('votes', '/fims/votes')
      .annotate(OpenApi.Summary, 'List votes with weighted results')
      .addSuccess(Schema.Array(Vote))
      .addError(AuthForbidden, { status: 403 })
      .addError(AuthUnauthorized, { status: 401 })
      .addError(DatabaseError, { status: 500 })
      .addError(DatabaseNotConfigured, { status: 503 }),
  )
  .add(
    HttpApiEndpoint.post('createVote', '/fims/votes')
      .annotate(OpenApi.Summary, 'Create vote (admin) or submit tontine proposal (member)')
      .setPayload(CreateVoteBody)
      .addSuccess(Vote)
      .addError(AuthUnauthorized, { status: 401 })
      .addError(AuthForbidden, { status: 403 })
      .addError(BadRequest, { status: 400 })
      .addError(NotFound, { status: 404 })
      .addError(DatabaseError, { status: 500 })
      .addError(DatabaseNotConfigured, { status: 503 }),
  )
  .add(
    HttpApiEndpoint.patch('updateVote', '/fims/votes/:id')
      .annotate(OpenApi.Summary, 'Update vote status (admin)')
      .setPath(Schema.Struct({ id: Schema.NumberFromString }))
      .setPayload(UpdateVoteBody)
      .addSuccess(Vote)
      .addError(AuthUnauthorized, { status: 401 })
      .addError(AuthForbidden, { status: 403 })
      .addError(NotFound, { status: 404 })
      .addError(DatabaseError, { status: 500 })
      .addError(DatabaseNotConfigured, { status: 503 }),
  )
  .add(
    HttpApiEndpoint.get('config', '/fims/config')
      .annotate(OpenApi.Summary, 'FiMs runtime config (proposal threshold, total invested)')
      .addSuccess(FimsConfig)
      .addError(DatabaseError, { status: 500 })
      .addError(DatabaseNotConfigured, { status: 503 }),
  )
  .add(
    HttpApiEndpoint.patch('updateConfig', '/fims/config')
      .annotate(OpenApi.Summary, 'Update FiMs config (admin)')
      .setPayload(UpdateConfigBody)
      .addSuccess(FimsConfig)
      .addError(AuthUnauthorized, { status: 401 })
      .addError(AuthForbidden, { status: 403 })
      .addError(BadRequest, { status: 400 })
      .addError(DatabaseError, { status: 500 })
      .addError(DatabaseNotConfigured, { status: 503 }),
  )
  .add(
    HttpApiEndpoint.post('recordDonation', '/fims/donations')
      .annotate(OpenApi.Summary, 'Record an on-chain tontine donation')
      .setPayload(RecordDonationBody)
      .addSuccess(Schema.Array(Transaction))
      .addError(AuthUnauthorized, { status: 401 })
      .addError(AuthForbidden, { status: 403 })
      .addError(BadRequest, { status: 400 })
      .addError(NotFound, { status: 404 })
      .addError(DatabaseError, { status: 500 })
      .addError(DatabaseNotConfigured, { status: 503 }),
  )
  .add(
    HttpApiEndpoint.get('wrappedConfig', '/fims/wrapped')
      .annotate(OpenApi.Summary, 'Custodial wrapped products (FiMs Euro / FiMs USD)')
      .addSuccess(WrappedConfig)
      .addError(DatabaseError, { status: 500 })
      .addError(DatabaseNotConfigured, { status: 503 }),
  )
  .add(
    HttpApiEndpoint.post('wrappedDeposit', '/fims/wrapped/deposit')
      .annotate(OpenApi.Summary, 'Verify a backing deposit and mint the wrapped FiMs token')
      .setPayload(WrappedTxBody)
      .addSuccess(WrappedResult)
      .addError(AuthUnauthorized, { status: 401 })
      .addError(AuthForbidden, { status: 403 })
      .addError(BadRequest, { status: 400 })
      .addError(CustodialUnavailable, { status: 503 })
      .addError(DatabaseError, { status: 500 })
      .addError(DatabaseNotConfigured, { status: 503 }),
  )
  .add(
    HttpApiEndpoint.post('wrappedRedeem', '/fims/wrapped/redeem')
      .annotate(OpenApi.Summary, 'Verify a wrapped-token return, burn it and send back the backing')
      .setPayload(WrappedTxBody)
      .addSuccess(WrappedResult)
      .addError(AuthUnauthorized, { status: 401 })
      .addError(AuthForbidden, { status: 403 })
      .addError(BadRequest, { status: 400 })
      .addError(CustodialUnavailable, { status: 503 })
      .addError(DatabaseError, { status: 500 })
      .addError(DatabaseNotConfigured, { status: 503 }),
  )
  .add(
    HttpApiEndpoint.post('castBallot', '/fims/votes/:id/ballot')
      .annotate(OpenApi.Summary, 'Cast or change a ballot')
      .setPath(Schema.Struct({ id: Schema.NumberFromString }))
      .setPayload(CastBallotBody)
      .addSuccess(Vote)
      .addError(AuthUnauthorized, { status: 401 })
      .addError(AuthForbidden, { status: 403 })
      .addError(BadRequest, { status: 400 })
      .addError(NotFound, { status: 404 })
      .addError(DatabaseError, { status: 500 })
      .addError(DatabaseNotConfigured, { status: 503 }),
  )
  .add(
    HttpApiEndpoint.get('users', '/fims/users')
      .annotate(OpenApi.Summary, 'List users')
      .setUrlParams(
        Schema.Struct({
          address: Schema.optional(Schema.String),
          name: Schema.optional(Schema.String),
          ...PaginationParams,
        }),
      )
      .addSuccess(Schema.Array(User))
      .addError(AuthForbidden, { status: 403 })
      .addError(AuthUnauthorized, { status: 401 })
      .addError(DatabaseError, { status: 500 })
      .addError(DatabaseNotConfigured, { status: 503 }),
  )
  .add(
    HttpApiEndpoint.post('createUser', '/fims/users')
      .annotate(OpenApi.Summary, 'Create user')
      .setPayload(CreateUserBody)
      .addSuccess(User)
      .addError(AuthUnauthorized, { status: 401 })
      .addError(AuthForbidden, { status: 403 })
      .addError(NotFound, { status: 400 })
      .addError(BadRequest, { status: 400 })
      .addError(DatabaseError, { status: 500 })
      .addError(DatabaseNotConfigured, { status: 503 }),
  )
  .add(
    HttpApiEndpoint.patch('updateUser', '/fims/users/:id')
      .annotate(OpenApi.Summary, 'Update user')
      .setPath(Schema.Struct({ id: Schema.NumberFromString }))
      .setPayload(UpdateUserBody)
      .addSuccess(User)
      .addError(AuthUnauthorized, { status: 401 })
      .addError(AuthForbidden, { status: 403 })
      .addError(NotFound, { status: 404 })
      .addError(BadRequest, { status: 400 })
      .addError(RateLimited, { status: 429 })
      .addError(DatabaseError, { status: 500 })
      .addError(DatabaseNotConfigured, { status: 503 }),
  )
  .add(
    HttpApiEndpoint.del('deleteUser', '/fims/users/:id')
      .annotate(OpenApi.Summary, 'Delete user')
      .setPath(Schema.Struct({ id: Schema.NumberFromString }))
      .addSuccess(Schema.String)
      .addError(AuthUnauthorized, { status: 401 })
      .addError(AuthForbidden, { status: 403 })
      .addError(NotFound, { status: 404 })
      .addError(DatabaseError, { status: 500 })
      .addError(DatabaseNotConfigured, { status: 503 }),
  )
  .add(
    HttpApiEndpoint.post('addUserAddress', '/fims/users/:id/addresses')
      .annotate(OpenApi.Summary, 'Link an extra wallet address to a user')
      .setPath(Schema.Struct({ id: Schema.NumberFromString }))
      .setPayload(LinkUserAddressBody)
      .addSuccess(UserAddress)
      .addError(AuthUnauthorized, { status: 401 })
      .addError(AuthForbidden, { status: 403 })
      .addError(NotFound, { status: 404 })
      .addError(BadRequest, { status: 400 })
      .addError(DatabaseError, { status: 500 })
      .addError(DatabaseNotConfigured, { status: 503 }),
  )
  .add(
    HttpApiEndpoint.del('removeUserAddress', '/fims/users/:id/addresses/:address')
      .annotate(OpenApi.Summary, 'Unlink a wallet address from a user')
      .setPath(Schema.Struct({ address: Schema.String, id: Schema.NumberFromString }))
      .addSuccess(Schema.String)
      .addError(AuthUnauthorized, { status: 401 })
      .addError(AuthForbidden, { status: 403 })
      .addError(NotFound, { status: 404 })
      .addError(DatabaseError, { status: 500 })
      .addError(DatabaseNotConfigured, { status: 503 }),
  )
  .add(
    HttpApiEndpoint.get('transactions', '/fims/transactions')
      .annotate(OpenApi.Summary, 'List transactions')
      .setUrlParams(
        Schema.Struct({
          address: Schema.optional(Schema.String),
          userId: Schema.optional(Schema.NumberFromString),
          ...PaginationParams,
        }),
      )
      .addSuccess(Schema.Array(Transaction))
      .addError(AuthForbidden, { status: 403 })
      .addError(AuthUnauthorized, { status: 401 })
      .addError(DatabaseError, { status: 500 })
      .addError(DatabaseNotConfigured, { status: 503 }),
  )
  .add(
    HttpApiEndpoint.post('createTransaction', '/fims/transactions')
      .annotate(OpenApi.Summary, 'Create transaction')
      .setPayload(CreateTransactionBody)
      .addSuccess(Transaction)
      .addError(AuthUnauthorized, { status: 401 })
      .addError(AuthForbidden, { status: 403 })
      .addError(BadRequest, { status: 400 })
      .addError(NotFound, { status: 404 })
      .addError(DatabaseError, { status: 500 })
      .addError(DatabaseNotConfigured, { status: 503 }),
  )
  .add(
    HttpApiEndpoint.patch('updateTransaction', '/fims/transactions/:id')
      .annotate(OpenApi.Summary, 'Update transaction')
      .setPath(Schema.Struct({ id: Schema.NumberFromString }))
      .setPayload(UpdateTransactionBody)
      .addSuccess(Transaction)
      .addError(AuthUnauthorized, { status: 401 })
      .addError(AuthForbidden, { status: 403 })
      .addError(NotFound, { status: 404 })
      .addError(DatabaseError, { status: 500 })
      .addError(DatabaseNotConfigured, { status: 503 }),
  )
  .add(
    HttpApiEndpoint.del('deleteTransaction', '/fims/transactions/:id')
      .annotate(OpenApi.Summary, 'Delete transaction')
      .setPath(Schema.Struct({ id: Schema.NumberFromString }))
      .addSuccess(Schema.String)
      .addError(AuthUnauthorized, { status: 401 })
      .addError(AuthForbidden, { status: 403 })
      .addError(NotFound, { status: 404 })
      .addError(DatabaseError, { status: 500 })
      .addError(DatabaseNotConfigured, { status: 503 }),
  )
  .add(
    HttpApiEndpoint.post('convertPosition', '/fims/conversions')
      .annotate(OpenApi.Summary, 'Rebalance: convert EUR value between two tokens')
      .setPayload(
        Schema.Struct({
          eurAmount: Schema.Number.pipe(Schema.greaterThan(0)),
          fromToken: Schema.String,
          // Idempotency key the client generates per conversion intent:
          // retried submissions are deduplicated by (user_id, request_id)
          // instead of double-applying the ledger pair.
          requestId: Schema.String.pipe(Schema.minLength(8), Schema.maxLength(64)),
          toToken: Schema.String,
        }),
      )
      .addSuccess(Schema.Array(Transaction))
      .addError(AuthUnauthorized, { status: 401 })
      .addError(AuthForbidden, { status: 403 })
      .addError(BadRequest, { status: 400 })
      .addError(NotFound, { status: 404 })
      .addError(DatabaseError, { status: 500 })
      .addError(DatabaseNotConfigured, { status: 503 }),
  )
  .add(
    HttpApiEndpoint.get('tokens', '/fims/tokens')
      .annotate(OpenApi.Summary, 'List tokens')
      .setUrlParams(Schema.Struct(PaginationParams))
      .addSuccess(Schema.Array(Token))
      .addError(DatabaseError, { status: 500 })
      .addError(DatabaseNotConfigured, { status: 503 }),
  )
  .add(
    HttpApiEndpoint.get('historic', '/fims/historic')
      .annotate(OpenApi.Summary, 'Global portfolio history')
      .setUrlParams(Schema.Struct(PaginationParams))
      .addSuccess(Schema.Array(HistoricPoint))
      .addError(DatabaseError, { status: 500 })
      .addError(DatabaseNotConfigured, { status: 503 }),
  )
  .add(
    HttpApiEndpoint.get('userHistoric', '/fims/user-historic')
      .annotate(OpenApi.Summary, 'Per-user portfolio history')
      .setUrlParams(Schema.Struct({ userId: Schema.optional(Schema.NumberFromString), ...PaginationParams }))
      .addSuccess(Schema.Array(UserHistoricPoint))
      .addError(AuthForbidden, { status: 403 })
      .addError(AuthUnauthorized, { status: 401 })
      .addError(DatabaseError, { status: 500 })
      .addError(DatabaseNotConfigured, { status: 503 }),
  )
  .add(
    HttpApiEndpoint.get('prices', '/fims/prices')
      .annotate(OpenApi.Summary, 'Token price history')
      .setUrlParams(Schema.Struct({ token: Schema.optional(Schema.String), ...PaginationParams }))
      .addSuccess(Schema.Array(PricePoint))
      .addError(DatabaseError, { status: 500 })
      .addError(DatabaseNotConfigured, { status: 503 }),
  )
  .add(
    HttpApiEndpoint.get('dashboard', '/fims/dashboard')
      .annotate(OpenApi.Summary, 'Dashboard metrics')
      .addSuccess(Schema.Array(DashboardMetric))
      .addError(DatabaseError, { status: 500 })
      .addError(DatabaseNotConfigured, { status: 503 }),
  )
  .add(
    HttpApiEndpoint.get('addressBook', '/fims/address-book')
      .annotate(OpenApi.Summary, 'List address book entries')
      .setUrlParams(Schema.Struct({ userId: Schema.optional(Schema.NumberFromString), ...PaginationParams }))
      .addSuccess(Schema.Array(AddressBookEntry))
      .addError(AuthForbidden, { status: 403 })
      .addError(AuthUnauthorized, { status: 401 })
      .addError(DatabaseError, { status: 500 })
      .addError(DatabaseNotConfigured, { status: 503 }),
  )
  .add(
    HttpApiEndpoint.post('createAddressBookEntry', '/fims/address-book')
      .annotate(OpenApi.Summary, 'Create address book entry')
      .setPayload(CreateAddressBookEntryBody)
      .addSuccess(AddressBookEntry)
      .addError(AuthUnauthorized, { status: 401 })
      .addError(AuthForbidden, { status: 403 })
      .addError(NotFound, { status: 404 })
      .addError(DatabaseError, { status: 500 })
      .addError(DatabaseNotConfigured, { status: 503 }),
  )
  .add(
    HttpApiEndpoint.patch('updateAddressBookEntry', '/fims/address-book/:id')
      .annotate(OpenApi.Summary, 'Update address book entry')
      .setPath(Schema.Struct({ id: Schema.NumberFromString }))
      .setPayload(UpdateAddressBookEntryBody)
      .addSuccess(AddressBookEntry)
      .addError(AuthUnauthorized, { status: 401 })
      .addError(AuthForbidden, { status: 403 })
      .addError(NotFound, { status: 404 })
      .addError(DatabaseError, { status: 500 })
      .addError(DatabaseNotConfigured, { status: 503 }),
  )
  .add(
    HttpApiEndpoint.del('deleteAddressBookEntry', '/fims/address-book/:id')
      .annotate(OpenApi.Summary, 'Delete address book entry')
      .setPath(Schema.Struct({ id: Schema.NumberFromString }))
      .addSuccess(Schema.String)
      .addError(AuthUnauthorized, { status: 401 })
      .addError(AuthForbidden, { status: 403 })
      .addError(NotFound, { status: 404 })
      .addError(DatabaseError, { status: 500 })
      .addError(DatabaseNotConfigured, { status: 503 }),
  )
  .add(
    // Signed label map for the tx reader: built-ins (treasury, tontine) plus
    // members and address-book entries so counterparties render with a name.
    // Signed because it exposes the shared address book (CEX deposit
    // addresses) — public would leak them.
    HttpApiEndpoint.get('chainLabels', '/fims/chain/labels')
      .annotate(OpenApi.Summary, 'Known-address labels for the on-chain tx reader')
      .addSuccess(Schema.Array(ChainLabel))
      .addError(AuthUnauthorized, { status: 401 })
      .addError(DatabaseError, { status: 500 })
      .addError(DatabaseNotConfigured, { status: 503 }),
  )
  .add(
    // Signed: proxying Helius spends paid credits, so callers must prove they
    // control a wallet. Pagination follows Helius `paginationToken` (opaque
    // cursor, "slot:position").
    HttpApiEndpoint.get('chainHistory', '/fims/chain/history')
      .annotate(OpenApi.Summary, 'Normalized on-chain history for an address (Helius proxy)')
      .setUrlParams(
        Schema.Struct({
          address: SolanaAddress,
          cursor: Schema.optional(Schema.String),
          limit: Schema.optional(Schema.NumberFromString),
        }),
      )
      .addSuccess(ChainHistoryPage)
      .addError(AuthUnauthorized, { status: 401 })
      .addError(BadRequest, { status: 400 })
      .addError(ChainUnavailable, { status: 503 })
      .addError(DatabaseError, { status: 500 })
      .addError(DatabaseNotConfigured, { status: 503 }),
  )
  .add(
    HttpApiEndpoint.get('chainAssets', '/fims/chain/assets')
      .annotate(OpenApi.Summary, 'Current token balances and USD prices for an address (Helius proxy)')
      .setUrlParams(Schema.Struct({ address: SolanaAddress }))
      .addSuccess(Schema.Array(ChainAsset))
      .addError(AuthUnauthorized, { status: 401 })
      .addError(ChainUnavailable, { status: 503 })
      .addError(DatabaseError, { status: 500 })
      .addError(DatabaseNotConfigured, { status: 503 }),
  )
  .add(
    // Keeper endpoints: shared-secret auth (x-strategy-secret), called by
    // cron-job.org. `status` returns 503 whenever the vault needs attention —
    // that is what makes the monitor alert. `delegate-run` executes one pass.
    HttpApiEndpoint.get('strategyStatus', '/fims/strategy/status')
      .annotate(OpenApi.Summary, 'Keeper health: pending deposits, failed ops, delegate fee balance')
      .addSuccess(StrategyHealth)
      .addError(AuthUnauthorized, { status: 401 })
      .addError(ChainUnavailable, { status: 503 })
      .addError(DatabaseError, { status: 500 })
      .addError(DatabaseNotConfigured, { status: 503 }),
  )
  .add(
    HttpApiEndpoint.post('strategyDelegateRun', '/fims/strategy/delegate-run')
      .annotate(OpenApi.Summary, 'Run one keeper pass: issue shares 1:1, place collateral')
      .addSuccess(DelegateRunReport)
      .addError(AuthUnauthorized, { status: 401 })
      .addError(ChainUnavailable, { status: 503 })
      .addError(DatabaseError, { status: 500 })
      .addError(DatabaseNotConfigured, { status: 503 }),
  ) {}
