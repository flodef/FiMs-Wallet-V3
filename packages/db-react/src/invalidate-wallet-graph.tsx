import type { DbContext } from '@workspace/db/db-context'
import { optionsAccount } from './options-account.tsx'
import { optionsSetting } from './options-setting.tsx'
import { optionsWallet } from './options-wallet.tsx'
import { queryClient } from './query-client.tsx'

// Wallets, accounts and the active-account setting move together (deleting a
// wallet deletes its accounts and may reassign activeAccountId). Every
// mutation touching one of them invalidates all three, so no consumer can
// observe a half-updated graph.
export function invalidateWalletGraph(ctx: DbContext) {
  return Promise.all([
    queryClient.invalidateQueries(optionsAccount.findMany(ctx, {})),
    queryClient.invalidateQueries(optionsSetting.findMany(ctx, {})),
    queryClient.invalidateQueries(optionsWallet.findMany(ctx, {})),
  ])
}
