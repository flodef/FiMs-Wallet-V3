import type { DbContext } from '@workspace/db/db-context'
import { queryClient } from './query-client.tsx'
import { optionsAccountFindMany, optionsSettingFindMany, optionsWalletFindMany } from './wallet-graph-queries.ts'

// Wallets, accounts and the active-account setting move together (deleting a
// wallet deletes its accounts and may reassign activeAccountId). Every
// mutation touching one of them invalidates all three, so no consumer can
// observe a half-updated graph.
export function invalidateWalletGraph(ctx: DbContext) {
  return Promise.all([
    queryClient.invalidateQueries(optionsAccountFindMany(ctx, {})),
    queryClient.invalidateQueries(optionsSettingFindMany(ctx, {})),
    queryClient.invalidateQueries(optionsWalletFindMany(ctx, {})),
  ])
}
