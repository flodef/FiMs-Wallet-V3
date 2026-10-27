import { HttpApiEndpoint, HttpApiGroup, OpenApi } from '@effect/platform'
import { Schema } from 'effect'
import { DatabaseError, DatabaseNotConfigured } from '../../db/service.js'
import { AuthForbidden, AuthUnauthorized } from '../../services/auth/service.js'
import {
  AddressBookEntry,
  BadRequest,
  CastBallotBody,
  ChainAsset,
  ChainHistoryPage,
  ChainLabel,
  ChainUnavailable,
  ConvertPositionBody,
  CreateAddressBookEntryBody,
  CreateSessionBody,
  CreateTransactionBody,
  CreateUserBody,
  CreateVoteBody,
  CustodialBackingStatus,
  CustodialSweepReport,
  CustodialUnavailable,
  DashboardMetric,
  DelegateRunReport,
  FimsConfig,
  HistoricPoint,
  LinkUserAddressBody,
  MemberSummary,
  NotFound,
  PaginationParams,
  PricePoint,
  RateLimited,
  RecordDonationBody,
  Session,
  SolanaAddress,
  StrategyHealth,
  Token,
  Transaction,
  UpdateAddressBookEntryBody,
  UpdateConfigBody,
  UpdateTransactionBody,
  UpdateUserBody,
  UpdateVoteBody,
  User,
  UserAddress,
  UserHistoricPoint,
  Vote,
  WrappedConfig,
  WrappedResult,
  WrappedTxBody,
} from './api-schemas.js'

export * from './api-schemas.js'
export class FimsApi extends HttpApiGroup.make('Fims')
  .add(
    HttpApiEndpoint.post('createSession', '/fims/session')
      .annotate(OpenApi.Summary, 'Sign in — mint a bearer session from a SIWS signature')
      .setPayload(CreateSessionBody)
      .addSuccess(Session)
      .addError(AuthUnauthorized, { status: 401 })
      .addError(DatabaseError, { status: 500 })
      .addError(DatabaseNotConfigured, { status: 503 }),
  )
  .add(
    HttpApiEndpoint.del('deleteSession', '/fims/session')
      .annotate(OpenApi.Summary, 'Revoke the bearer session')
      .addSuccess(Schema.String)
      .addError(AuthUnauthorized, { status: 401 })
      .addError(DatabaseError, { status: 500 })
      .addError(DatabaseNotConfigured, { status: 503 }),
  )
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
      .addError(BadRequest, { status: 400 })
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
      .setPayload(ConvertPositionBody)
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
    // Live member summary recomputed from the ledger — replaces the stale
    // user_historic snapshot for the portfolio tile. Null when the member is
    // unknown or private to the caller (same visibility as transactions).
    HttpApiEndpoint.get('memberSummary', '/fims/member-summary')
      .annotate(OpenApi.Summary, 'Member portfolio summary from the ledger (invested, P&L, rates)')
      .setUrlParams(Schema.Struct({ userId: Schema.NumberFromString }))
      .addSuccess(Schema.NullOr(MemberSummary))
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
      .addError(AuthForbidden, { status: 403 })
      .addError(BadRequest, { status: 400 })
      .addError(RateLimited, { status: 429 })
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
      .addError(AuthForbidden, { status: 403 })
      .addError(RateLimited, { status: 429 })
      .addError(ChainUnavailable, { status: 503 })
      .addError(DatabaseError, { status: 500 })
      .addError(DatabaseNotConfigured, { status: 503 }),
  )
  .add(
    // Helius webhook delivery: shared-secret auth in x-helius-auth, deduped
    // via used_signatures, recorded into chain_events.
    HttpApiEndpoint.post('chainWebhook', '/fims/chain/webhook')
      .annotate(OpenApi.Summary, 'Helius webhook intake — records chain events for watched addresses')
      .setPayload(Schema.Unknown)
      .addSuccess(Schema.Unknown)
      .addError(AuthForbidden, { status: 403 })
      .addError(ChainUnavailable, { status: 503 })
      .addError(DatabaseError, { status: 500 }),
  )
  .add(
    // Cursor feed for realtime updates: events with id > after.
    HttpApiEndpoint.get('chainEvents', '/fims/chain/events')
      .annotate(OpenApi.Summary, 'Chain events cursor feed (after=id, oldest first)')
      .setUrlParams(Schema.Struct({ after: Schema.optional(Schema.NumberFromString) }))
      .addSuccess(
        Schema.Array(
          Schema.Struct({
            address: Schema.String,
            id: Schema.Number,
            signature: Schema.String,
          }),
        ),
      )
      .addError(RateLimited, { status: 429 })
      .addError(ChainUnavailable, { status: 503 }),
  )
  .add(
    // Anonymous JSON-RPC relay: the browser's Solana client points here so no
    // API key ships in the bundle. Method allowlist + IP/global quotas inside.
    HttpApiEndpoint.post('chainRpc', '/fims/chain/rpc')
      .annotate(OpenApi.Summary, 'JSON-RPC relay to the upstream provider (key stays server-side)')
      .setPayload(Schema.Unknown)
      .addSuccess(Schema.Unknown)
      .addError(BadRequest, { status: 400 })
      .addError(RateLimited, { status: 429 })
      .addError(ChainUnavailable, { status: 503 }),
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
  )
  .add(
    // Custodial keeper: same shared-secret auth. `backing-status` is the
    // monitor (503 = unbacked supply or sweep broken); `sweep` moves the
    // excess above each product's float into the Squads vault.
    HttpApiEndpoint.get('custodialBackingStatus', '/fims/custodial/backing-status')
      .annotate(OpenApi.Summary, 'Wrapped supply vs float + vault backing')
      .addSuccess(CustodialBackingStatus)
      .addError(AuthUnauthorized, { status: 401 })
      .addError(ChainUnavailable, { status: 503 })
      .addError(DatabaseNotConfigured, { status: 503 }),
  )
  .add(
    HttpApiEndpoint.post('custodialSweep', '/fims/custodial/sweep')
      .annotate(OpenApi.Summary, 'Sweep backing above each float target into the multisig vault')
      .addSuccess(Schema.Array(CustodialSweepReport))
      .addError(AuthUnauthorized, { status: 401 })
      .addError(ChainUnavailable, { status: 503 })
      .addError(DatabaseNotConfigured, { status: 503 }),
  ) {}
