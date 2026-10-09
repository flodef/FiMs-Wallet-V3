// FiMs API route handlers — one file per domain under ./handlers/.
// This file only wires them into the Effect HttpApiBuilder.
import { HttpApiBuilder } from '@effect/platform'
import { Effect, Layer } from 'effect'
import { Api } from '../../api.js'
import { DatabaseService } from '../../db/service.js'
import {
  handleAddressBook,
  handleCreateAddressBookEntry,
  handleDeleteAddressBookEntry,
  handleUpdateAddressBookEntry,
} from './handlers/book.js'
import { handleChainAssets, handleChainHistory, handleChainLabels } from './handlers/chain.js'
import { handleConvertPosition } from './handlers/convert.js'
import {
  handleCustodialBackingStatus,
  handleCustodialSweep,
  handleStrategyDelegateRun,
  handleStrategyStatus,
} from './handlers/cron.js'
import { handleRecordDonation } from './handlers/donations.js'
import {
  handleCreateTransaction,
  handleDashboard,
  handleDeleteTransaction,
  handleHistoric,
  handlePrices,
  handleTokens,
  handleTransactions,
  handleUpdateTransaction,
  handleUserHistoric,
} from './handlers/ledger.js'
import { handleCreateSession, handleDeleteSession } from './handlers/session.js'
import {
  handleAddUserAddress,
  handleCreateUser,
  handleDeleteUser,
  handleRemoveUserAddress,
  handleUpdateUser,
  handleUsers,
} from './handlers/users.js'
import {
  handleCastBallot,
  handleConfig,
  handleCreateVote,
  handleUpdateConfig,
  handleUpdateVote,
  handleVotes,
} from './handlers/votes.js'
import { handleWrappedConfig, handleWrappedDeposit, handleWrappedRedeem } from './handlers/wrapped.js'

export const HttpFimsLive = HttpApiBuilder.group(Api, 'Fims', (handlers) =>
  Effect.succeed(
    handlers
      // SIWS sign-in: one signature → bearer session (7d). The signed path
      // stays for compatibility, but clients should only need it once.
      .handle('createSession', handleCreateSession)
      .handle('deleteSession', handleDeleteSession)
      .handle('users', handleUsers)
      .handle('createUser', handleCreateUser)
      .handle('updateUser', handleUpdateUser)
      .handle('deleteUser', handleDeleteUser)
      .handle('addUserAddress', handleAddUserAddress)
      .handle('removeUserAddress', handleRemoveUserAddress)
      .handle('transactions', handleTransactions)
      .handle('createTransaction', handleCreateTransaction)
      .handle('updateTransaction', handleUpdateTransaction)
      .handle('deleteTransaction', handleDeleteTransaction)
      .handle('tokens', handleTokens)
      .handle('historic', handleHistoric)
      .handle('userHistoric', handleUserHistoric)
      .handle('prices', handlePrices)
      .handle('dashboard', handleDashboard)
      .handle('addressBook', handleAddressBook)
      .handle('createAddressBookEntry', handleCreateAddressBookEntry)
      .handle('updateAddressBookEntry', handleUpdateAddressBookEntry)
      .handle('deleteAddressBookEntry', handleDeleteAddressBookEntry)
      .handle('convertPosition', handleConvertPosition)
      .handle('votes', handleVotes)
      .handle('createVote', handleCreateVote)
      .handle('updateVote', handleUpdateVote)
      .handle('castBallot', handleCastBallot)
      .handle('config', handleConfig)
      .handle('updateConfig', handleUpdateConfig)
      .handle('recordDonation', handleRecordDonation)
      .handle('wrappedConfig', handleWrappedConfig)
      .handle('wrappedDeposit', handleWrappedDeposit)
      .handle('wrappedRedeem', handleWrappedRedeem)
      .handle('chainLabels', handleChainLabels)
      .handle('chainHistory', handleChainHistory)
      .handle('chainAssets', handleChainAssets)
      .handle('strategyStatus', handleStrategyStatus)
      .handle('strategyDelegateRun', handleStrategyDelegateRun)
      .handle('custodialBackingStatus', handleCustodialBackingStatus)
      .handle('custodialSweep', handleCustodialSweep),
  ),
).pipe(Layer.provide([DatabaseService.Default]))
