import type { PromiseExtended } from 'dexie'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { accountCreate } from '../src/account/account-create.ts'
import { accountFindUnique } from '../src/account/account-find-unique.ts'
import { settingFindUnique } from '../src/setting/setting-find-unique.ts'
import { settingSetValue } from '../src/setting/setting-set-value.ts'
import { walletCreate } from '../src/wallet/wallet-create.ts'
import { walletDelete } from '../src/wallet/wallet-delete.ts'
import { walletFindUnique } from '../src/wallet/wallet-find-unique.ts'
import {
  createDbContextTest,
  createPasswordTestVault,
  testAccountCreateInput,
  testWalletCreateInput,
} from './test-helpers.ts'

const ctx = createDbContextTest()

describe('wallet-delete', () => {
  beforeEach(async () => {
    await ctx.db.accounts.clear()
    await ctx.db.wallets.clear()
    await createPasswordTestVault(ctx)
  })

  describe('expected behavior', () => {
    it('should delete a wallet', async () => {
      // ARRANGE
      expect.assertions(1)
      // We create the first wallet so that will be the default. The second is the one that will be deleted.
      const first = await walletCreate(ctx, testWalletCreateInput())
      await accountCreate(ctx, testAccountCreateInput({ walletId: first }))
      const input = testWalletCreateInput()
      const id = await walletCreate(ctx, input)

      // ACT
      await walletDelete(ctx, id)

      // ASSERT
      const deletedItem = await walletFindUnique(ctx, id)
      expect(deletedItem).toBeNull()
    })

    it('should delete a wallet when no active account is set', async () => {
      // ARRANGE
      expect.assertions(1)
      const first = await walletCreate(ctx, testWalletCreateInput())
      await accountCreate(ctx, testAccountCreateInput({ walletId: first }))
      const id = await walletCreate(ctx, testWalletCreateInput())
      await accountCreate(ctx, testAccountCreateInput({ walletId: id }))
      // Simulate the dangling-pointer state the loader repairs: the setting
      // is gone but accounts exist. Deletion must not brick on it.
      await ctx.db.settings.delete('activeAccountId')

      // ACT
      await walletDelete(ctx, id)

      // ASSERT
      expect(await walletFindUnique(ctx, id)).toBeNull()
    })

    it('should reassign the lowest-order account when deleting the active external wallet', async () => {
      // ARRANGE
      expect.assertions(2)
      const externalId = await walletCreate(
        ctx,
        testWalletCreateInput({ derivationPath: '', externalWallet: 'Solflare', mnemonic: '' }),
      )
      const externalAccount = await accountCreate(
        ctx,
        testAccountCreateInput({ externalWallet: 'Solflare', type: 'Connected', walletId: externalId }),
      )
      const localId = await walletCreate(ctx, testWalletCreateInput())
      // `order` is per-wallet: the lowest-order account of the surviving
      // wallet is the first one created here.
      const expected = await accountCreate(ctx, testAccountCreateInput({ name: 'zzz', walletId: localId }))
      await accountCreate(ctx, testAccountCreateInput({ name: 'aaa', walletId: localId }))
      await settingSetValue(ctx, 'activeAccountId', externalAccount)

      // ACT
      await walletDelete(ctx, externalId)

      // ASSERT
      const active = await settingFindUnique(ctx, 'activeAccountId')
      expect(await accountFindUnique(ctx, externalAccount)).toBeNull()
      expect(active?.value).toBe(expected)
    })

    it('should clear the active account when deleting the last external wallet', async () => {
      // ARRANGE
      expect.assertions(2)
      const externalId = await walletCreate(
        ctx,
        testWalletCreateInput({ derivationPath: '', externalWallet: 'Solflare', mnemonic: '' }),
      )
      await accountCreate(
        ctx,
        testAccountCreateInput({ externalWallet: 'Solflare', type: 'Connected', walletId: externalId }),
      )

      // ACT
      await walletDelete(ctx, externalId)

      // ASSERT
      expect(await walletFindUnique(ctx, externalId)).toBeNull()
      expect(await settingFindUnique(ctx, 'activeAccountId')).toBeNull()
    })

    it('should delete the accounts in a wallet', async () => {
      // ARRANGE
      expect.assertions(2)
      // We create the first wallet so that will be the default. The second is the one that will be deleted.
      const first = await walletCreate(ctx, testWalletCreateInput())
      await accountCreate(ctx, testAccountCreateInput({ walletId: first }))
      const input = testWalletCreateInput()
      const id = await walletCreate(ctx, input)
      const accountId = await accountCreate(ctx, testAccountCreateInput({ walletId: id }))

      // ACT
      await walletDelete(ctx, id)

      // ASSERT
      const deletedWallet = await walletFindUnique(ctx, id)
      const deletedAccount = await accountFindUnique(ctx, accountId)
      expect(deletedWallet).toBeNull()
      expect(deletedAccount).toBeNull()
    })
  })

  describe('unexpected behavior', () => {
    beforeEach(() => {
      vi.spyOn(console, 'log').mockImplementation(() => {})
    })

    afterEach(() => {
      vi.restoreAllMocks()
    })

    it('should not delete an active wallet', async () => {
      // ARRANGE
      expect.assertions(1)
      const input = testWalletCreateInput()
      const id = await walletCreate(ctx, input)
      await accountCreate(ctx, testAccountCreateInput({ walletId: id }))

      // ACT & ASSERT
      await expect(walletDelete(ctx, id)).rejects.toThrow(
        'You cannot delete the active wallet. Please change wallets and try again.',
      )
    })

    it('should throw an error when deleting a wallet fails', async () => {
      // ARRANGE
      expect.assertions(1)
      const first = await walletCreate(ctx, testWalletCreateInput())
      await accountCreate(ctx, testAccountCreateInput({ walletId: first }))
      const id = await walletCreate(ctx, testWalletCreateInput())
      // const id = 'test-id'
      vi.spyOn(ctx.db.wallets, 'delete').mockImplementationOnce(
        () => Promise.reject(new Error('Test error')) as PromiseExtended<void>,
      )

      // ACT & ASSERT
      await expect(walletDelete(ctx, id)).rejects.toThrow(`Error deleting wallet with id ${id}`)
    })
  })
})
