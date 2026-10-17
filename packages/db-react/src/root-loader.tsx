import type { Account } from '@workspace/db/account/account'
import type { DbContext } from '@workspace/db/db-context'
import type { Network } from '@workspace/db/network/network'
import type { Setting } from '@workspace/db/setting/setting'
import type { Wallet } from '@workspace/db/wallet/wallet'
import { optionsAccount } from './options-account.tsx'
import { optionsNetwork } from './options-network.tsx'
import { optionsSetting } from './options-setting.tsx'
import { optionsWallet } from './options-wallet.tsx'
import { queryClient } from './query-client.tsx'

export interface RootLoaderData {
  accounts: Account[]
  networks: Network[]
  settings: Setting[]
  wallets: Wallet[]
}

export async function rootLoader(ctx: DbContext) {
  // Always read Dexie fresh (staleTime 0): the loader decides redirects and
  // repairs dangling ids, so a stale cached list (e.g. accounts of a wallet
  // just deleted) would make it resurrect a gone account. Local IndexedDB
  // reads are cheap; the cache is still refreshed for the live hooks.
  const [accounts, networks, settings, wallets] = await Promise.all([
    queryClient.fetchQuery({ ...optionsAccount.findMany(ctx, {}), staleTime: 0 }),
    queryClient.fetchQuery({ ...optionsNetwork.findMany(ctx, {}), staleTime: 0 }),
    queryClient.fetchQuery({ ...optionsSetting.findMany(ctx, {}), staleTime: 0 }),
    queryClient.fetchQuery({ ...optionsWallet.findMany(ctx, {}), staleTime: 0 }),
  ])

  return {
    accounts,
    networks,
    settings,
    wallets,
  }
}
