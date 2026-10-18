import 'fake-indexeddb/auto'

import { accountCreate } from '@workspace/db/account/account-create'
import type { DbContext } from '@workspace/db/db-context'
import { createDbContextTest, testAccountCreateInput, testWalletCreateInput } from '@workspace/db/test-helpers'
import { walletCreate } from '@workspace/db/wallet/wallet-create'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { optionsAccount } from '../src/options-account.tsx'
import { optionsSetting } from '../src/options-setting.tsx'
import { optionsWallet } from '../src/options-wallet.tsx'
import { queryClient } from '../src/query-client.tsx'

function chainRow(address: string, signature: string) {
  return {
    address,
    description: 'tx',
    feeSol: 0,
    signature,
    source: null,
    timestamp: Date.now(),
    transfers: [],
    type: 'TRANSFER',
  }
}

const ctx: DbContext = createDbContextTest()

async function seedWalletWithAccount() {
  const walletId = await walletCreate(ctx, testWalletCreateInput({ name: 'w1' }))
  const accountId = await accountCreate(ctx, testAccountCreateInput({ walletId }))
  // accountCreate claims activeAccountId — clear it so the delete guards
  // stay out of the way of the cleanup assertions.
  await ctx.db.settings.where('key').equals('activeAccountId').delete()
  return { accountId, walletId }
}

describe('wallet-graph-mutations', () => {
  beforeEach(async () => {
    await ctx.db.accounts.clear()
    await ctx.db.wallets.clear()
    await ctx.db.settings.clear()
    await ctx.db.chainTransactions.clear()
    await ctx.vault.create({ password: 'password-one' })
    vi.spyOn(queryClient, 'invalidateQueries').mockResolvedValue(undefined)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe('expected behavior', () => {
    it('should purge the chain cache and invalidate the wallet graph when deleting an account', async () => {
      // ARRANGE
      expect.assertions(3)
      const { accountId } = await seedWalletWithAccount()
      const account = await ctx.db.accounts.get(accountId)
      if (!account) throw new Error('seed failed')
      await ctx.db.chainTransactions.add(chainRow(account.publicKey, 'sig-1'))

      // ACT
      await optionsAccount.delete(ctx).mutationFn?.({ id: accountId }, undefined as never)
      await optionsAccount.delete(ctx).onSuccess?.(undefined, { id: accountId }, undefined as never, undefined as never)

      // ASSERT
      expect(await ctx.db.accounts.get(accountId)).toBeUndefined()
      expect(await ctx.db.chainTransactions.where('address').equals(account.publicKey).count()).toBe(0)
      expect(queryClient.invalidateQueries).toHaveBeenCalled()
    })

    it('should persist the value and invalidate the settings query on setValue', async () => {
      // ARRANGE
      expect.assertions(3)

      // ACT
      await optionsSetting.update(ctx, 'activeNetworkId').mutationFn?.('networkDevnet', undefined as never)
      await optionsSetting
        .update(ctx, 'activeNetworkId')
        .onSuccess?.(undefined, 'networkDevnet', undefined as never, undefined as never)

      // ASSERT
      const row = (await ctx.db.settings.where('key').equals('activeNetworkId').first())?.value
      expect(row).toBe('networkDevnet')
      expect(queryClient.invalidateQueries).toHaveBeenCalled()
      // and a second write updates the SAME row (key index), not a duplicate
      await optionsSetting.update(ctx, 'activeNetworkId').mutationFn?.('networkMainnet', undefined as never)
      expect(await ctx.db.settings.where('key').equals('activeNetworkId').count()).toBe(1)
    })

    it('should purge every removed account cache when deleting a wallet', async () => {
      // ARRANGE
      expect.assertions(3)
      const { accountId, walletId } = await seedWalletWithAccount()
      const account = await ctx.db.accounts.get(accountId)
      if (!account) throw new Error('seed failed')
      await ctx.db.chainTransactions.add(chainRow(account.publicKey, 'sig-2'))
      await ctx.db.chainTransactions.add(chainRow('other-address', 'sig-3'))

      // ACT
      await optionsWallet.delete(ctx).mutationFn?.({ id: walletId }, undefined as never)

      // ASSERT
      expect(await ctx.db.wallets.get(walletId)).toBeUndefined()
      expect(await ctx.db.chainTransactions.where('address').equals(account.publicKey).count()).toBe(0)
      expect(await ctx.db.chainTransactions.where('address').equals('other-address').count()).toBe(1)
    })
  })
})
