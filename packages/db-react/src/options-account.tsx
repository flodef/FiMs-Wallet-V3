import { type MutateOptions, mutationOptions } from '@tanstack/react-query'
import { accountCreate } from '@workspace/db/account/account-create'
import type { AccountCreateInput } from '@workspace/db/account/account-create-input'
import { accountDelete } from '@workspace/db/account/account-delete'
import { accountReadSecretKey } from '@workspace/db/account/account-read-secret-key'
import { accountSetActive } from '@workspace/db/account/account-set-active'
import { accountUpdate } from '@workspace/db/account/account-update'
import type { AccountUpdateInput } from '@workspace/db/account/account-update-input'
import { accountUpdateOrder } from '@workspace/db/account/account-update-order'
import type { AccountUpdateOrderInput } from '@workspace/db/account/account-update-order-input'
import type { DbContext } from '@workspace/db/db-context'
import { accountCleanup } from './account-cleanup.tsx'
import { invalidateWalletGraph } from './invalidate-wallet-graph.tsx'
import { optionsAccountFindMany } from './wallet-graph-queries.ts'

export type AccountCreateMutateOptions = MutateOptions<string, Error, { input: AccountCreateInput }>
export type AccountDeleteMutateOptions = MutateOptions<void, Error, { id: string }>
export type AccountReadSecretKeyMutateOptions = MutateOptions<string | undefined, Error, { id: string }>
export type AccountSetActiveMutateOptions = MutateOptions<void, Error, { id: string }>
export type AccountUpdateMutateOptions = MutateOptions<void, Error, { id: string; input: AccountUpdateInput }>
export type AccountUpdateOrderMutateOptions = MutateOptions<void, Error, { input: AccountUpdateOrderInput }>

export const optionsAccount = {
  create: (ctx: DbContext, props: AccountCreateMutateOptions = {}) =>
    mutationOptions({
      mutationFn: ({ input }: { input: AccountCreateInput }) => accountCreate(ctx, input),
      onSuccess: () => invalidateWalletGraph(ctx),
      ...props,
    }),
  delete: (ctx: DbContext, props: AccountDeleteMutateOptions = {}) =>
    mutationOptions({
      mutationFn: async ({ id }: { id: string }) => {
        // Read first: after accountDelete the row (and its publicKey) is gone.
        const account = await ctx.db.accounts.get(id)
        await accountDelete(ctx, id)
        if (account) {
          // Best-effort — a Dexie/cache hiccup must not flip the mutation to
          // error and skip invalidateWalletGraph, but keep it observable.
          await accountCleanup(ctx, account.publicKey).catch((error: unknown) =>
            console.warn('account cleanup failed', error),
          )
        }
      },
      onSuccess: () => invalidateWalletGraph(ctx),
      ...props,
    }),
  findMany: optionsAccountFindMany,
  readSecretKey: (ctx: DbContext, props: AccountReadSecretKeyMutateOptions = {}) =>
    mutationOptions({
      mutationFn: ({ id }: { id: string }) => accountReadSecretKey(ctx, id),
      ...props,
    }),
  setActive: (ctx: DbContext, props: AccountSetActiveMutateOptions = {}) =>
    mutationOptions({
      mutationFn: ({ id }: { id: string }) => accountSetActive(ctx, id),
      onSuccess: () => invalidateWalletGraph(ctx),
      ...props,
    }),
  update: (ctx: DbContext, props: AccountUpdateMutateOptions = {}) =>
    mutationOptions({
      mutationFn: ({ id, input }: { id: string; input: AccountUpdateInput }) => accountUpdate(ctx, id, input),
      onSuccess: () => invalidateWalletGraph(ctx),
      ...props,
    }),
  updateOrder: (ctx: DbContext, props: AccountUpdateOrderMutateOptions = {}) =>
    mutationOptions({
      mutationFn: ({ input }: { input: AccountUpdateOrderInput }) => accountUpdateOrder(ctx, input),
      onSuccess: () => invalidateWalletGraph(ctx),
      ...props,
    }),
}
