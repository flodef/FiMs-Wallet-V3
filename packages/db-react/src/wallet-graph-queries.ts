import { queryOptions } from '@tanstack/react-query'
import { accountFindMany } from '@workspace/db/account/account-find-many'
import type { AccountFindManyInput } from '@workspace/db/account/account-find-many-input'
import type { DbContext } from '@workspace/db/db-context'
import { settingFindMany } from '@workspace/db/setting/setting-find-many'
import type { SettingFindManyInput } from '@workspace/db/setting/setting-find-many-input'
import { walletFindMany } from '@workspace/db/wallet/wallet-find-many'
import type { WalletFindManyInput } from '@workspace/db/wallet/wallet-find-many-input'

// findMany key factories for the wallet graph (wallets, accounts, settings)
// live in this leaf module: both the options objects and the invalidation
// helper depend on them — through a leaf, not on each other, so there is no
// import cycle between options-* and invalidate-wallet-graph.
export function optionsAccountFindMany(ctx: DbContext, input: AccountFindManyInput) {
  return queryOptions({
    queryFn: () => accountFindMany(ctx, input),
    queryKey: ['accountFindMany', input],
  })
}

export function optionsSettingFindMany(ctx: DbContext, input: SettingFindManyInput) {
  return queryOptions({
    queryFn: () => settingFindMany(ctx, input),
    queryKey: ['settingFindMany', input],
  })
}

export function optionsWalletFindMany(ctx: DbContext, input: WalletFindManyInput) {
  return queryOptions({
    queryFn: () => walletFindMany(ctx, input),
    queryKey: ['walletFindMany', input],
  })
}
