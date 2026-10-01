import { HttpApiEndpoint, HttpApiGroup, OpenApi } from '@effect/platform'
import { Schema } from 'effect'
import { DatabaseError, DatabaseNotConfigured } from '../../db/service.ts'
import { AuthForbidden, AuthUnauthorized } from '../../services/auth/service.ts'

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
  createdAt: Schema.Date,
  id: Schema.Number,
  isPro: Schema.Boolean,
  isPublic: Schema.Boolean,
  name: Schema.String,
  updatedAt: Schema.Date,
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

export class FimsApi extends HttpApiGroup.make('Fims')
  .add(
    HttpApiEndpoint.get('users', '/fims/users')
      .annotate(OpenApi.Summary, 'List users')
      .setUrlParams(Schema.Struct({ address: Schema.optional(Schema.String), name: Schema.optional(Schema.String) }))
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
    HttpApiEndpoint.get('transactions', '/fims/transactions')
      .annotate(OpenApi.Summary, 'List transactions')
      .setUrlParams(
        Schema.Struct({
          address: Schema.optional(Schema.String),
          userId: Schema.optional(Schema.NumberFromString),
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
    HttpApiEndpoint.get('tokens', '/fims/tokens')
      .annotate(OpenApi.Summary, 'List tokens')
      .addSuccess(Schema.Array(Token))
      .addError(DatabaseError, { status: 500 })
      .addError(DatabaseNotConfigured, { status: 503 }),
  )
  .add(
    HttpApiEndpoint.get('historic', '/fims/historic')
      .annotate(OpenApi.Summary, 'Global portfolio history')
      .addSuccess(Schema.Array(HistoricPoint))
      .addError(DatabaseError, { status: 500 })
      .addError(DatabaseNotConfigured, { status: 503 }),
  )
  .add(
    HttpApiEndpoint.get('userHistoric', '/fims/user-historic')
      .annotate(OpenApi.Summary, 'Per-user portfolio history')
      .setUrlParams(Schema.Struct({ userId: Schema.optional(Schema.NumberFromString) }))
      .addSuccess(Schema.Array(UserHistoricPoint))
      .addError(AuthForbidden, { status: 403 })
      .addError(AuthUnauthorized, { status: 401 })
      .addError(DatabaseError, { status: 500 })
      .addError(DatabaseNotConfigured, { status: 503 }),
  )
  .add(
    HttpApiEndpoint.get('prices', '/fims/prices')
      .annotate(OpenApi.Summary, 'Token price history')
      .setUrlParams(Schema.Struct({ token: Schema.optional(Schema.String) }))
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
      .setUrlParams(Schema.Struct({ userId: Schema.optional(Schema.NumberFromString) }))
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
  ) {}
