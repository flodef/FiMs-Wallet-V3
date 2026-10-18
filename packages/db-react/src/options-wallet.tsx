import { type MutateOptions, mutationOptions } from '@tanstack/react-query'
import type { DbContext } from '@workspace/db/db-context'
import { walletCreate } from '@workspace/db/wallet/wallet-create'
import type { WalletCreateInput } from '@workspace/db/wallet/wallet-create-input'
import { walletDelete } from '@workspace/db/wallet/wallet-delete'
import { walletReadMnemonic } from '@workspace/db/wallet/wallet-read-mnemonic'
import { type WalletReprotectInput, walletReprotect } from '@workspace/db/wallet/wallet-reprotect'
import { walletUpdate } from '@workspace/db/wallet/wallet-update'
import type { WalletUpdateInput } from '@workspace/db/wallet/wallet-update-input'
import { walletUpdateOrder } from '@workspace/db/wallet/wallet-update-order'
import type { WalletUpdateOrderInput } from '@workspace/db/wallet/wallet-update-order-input'
import { accountCleanup } from './account-cleanup.tsx'
import { invalidateWalletGraph } from './invalidate-wallet-graph.tsx'
import { optionsWalletFindMany } from './wallet-graph-queries.ts'

export type WalletCreateMutateOptions = MutateOptions<string, Error, { input: WalletCreateInput }>
export type WalletDeleteMutateOptions = MutateOptions<void, Error, { id: string }>
export type WalletReadMnemonicMutateOptions = MutateOptions<string, Error, { id: string }>
export type WalletReprotectMutateOptions = MutateOptions<void, Error, WalletReprotectInput>
export type WalletUpdateMutateOptions = MutateOptions<number, Error, { id: string; input: WalletUpdateInput }>
export type WalletUpdateOrderMutateOptions = MutateOptions<void, Error, { input: WalletUpdateOrderInput }>

export const optionsWallet = {
  create: (ctx: DbContext, props: WalletCreateMutateOptions = {}) =>
    mutationOptions({
      mutationFn: ({ input }: { input: WalletCreateInput }) => walletCreate(ctx, input),
      onSuccess: () => invalidateWalletGraph(ctx),
      ...props,
    }),
  delete: (ctx: DbContext, props: WalletDeleteMutateOptions = {}) =>
    mutationOptions({
      mutationFn: async ({ id }: { id: string }) => {
        // Read first: walletDelete removes the accounts with the wallet.
        const accounts = await ctx.db.accounts.where('walletId').equals(id).toArray()
        await walletDelete(ctx, id)
        for (const account of accounts) {
          await accountCleanup(ctx, account.publicKey).catch(() => {})
        }
      },
      onSuccess: () => invalidateWalletGraph(ctx),
      ...props,
    }),
  findMany: optionsWalletFindMany,
  readMnemonic: (ctx: DbContext, props: WalletReadMnemonicMutateOptions = {}) =>
    mutationOptions({
      mutationFn: ({ id }: { id: string }) => walletReadMnemonic(ctx, id),
      ...props,
    }),
  reprotect: (ctx: DbContext, props: WalletReprotectMutateOptions = {}) =>
    mutationOptions({
      mutationFn: (input: WalletReprotectInput) => walletReprotect(ctx, input),
      onSuccess: () => invalidateWalletGraph(ctx),
      ...props,
    }),
  update: (ctx: DbContext, props: WalletUpdateMutateOptions = {}) =>
    mutationOptions({
      mutationFn: ({ id, input }: { id: string; input: WalletUpdateInput }) => walletUpdate(ctx, id, input),
      onSuccess: () => invalidateWalletGraph(ctx),
      ...props,
    }),
  updateOrder: (ctx: DbContext, props: WalletUpdateOrderMutateOptions = {}) =>
    mutationOptions({
      mutationFn: ({ input }: { input: WalletUpdateOrderInput }) => walletUpdateOrder(ctx, input),
      onSuccess: () => invalidateWalletGraph(ctx),
      ...props,
    }),
}
