import 'fake-indexeddb/auto'
import { address } from '@solana/kit'
import { accountCreate } from '@workspace/db/account/account-create'
import type { AccountCreateInput } from '@workspace/db/account/account-create-input'
import { createDb } from '@workspace/db/create-db'
import { createDbVault } from '@workspace/db/create-db-vault'
import type { DbContext } from '@workspace/db/db-context'
import { randomId } from '@workspace/db/random-id'
import { settingSetValue } from '@workspace/db/setting/setting-set-value'
import { walletCreate } from '@workspace/db/wallet/wallet-create'
import type { WalletCreateInput } from '@workspace/db/wallet/wallet-create-input'
import { describe, expect, it } from 'vitest'
import { demoCleanupStale, demoCleanupWallet } from '../src/demo/demo-cleanup.ts'

const DEMO_PK = 'So11111111111111111111111111111111111111112'

function createCtx(): DbContext {
  const db = createDb({ name: `test-${randomId(8)}` })
  return { db, vault: createDbVault({ db }) }
}

const walletInput = (name: string): WalletCreateInput => ({
  derivationPath: 'd',
  mnemonic: 'seed',
  name,
  protection: { mode: 'unsecured' },
})

const accountInput = (walletId: string, publicKey: string): AccountCreateInput => ({
  name: `acc-${randomId(4)}`,
  publicKey: address(publicKey),
  secretKey: 'key',
  type: 'Derived',
  walletId,
})

describe('demoCleanupWallet', () => {
  it('deletes the demo wallet + accounts and clears a dangling activeAccountId', async () => {
    // ARRANGE
    expect.assertions(3)
    const ctx = createCtx()
    const walletId = await walletCreate(ctx, walletInput('Démo'))
    const accountId = await accountCreate(ctx, accountInput(walletId, DEMO_PK))
    await settingSetValue(ctx, 'activeAccountId', accountId)

    // ACT
    await demoCleanupWallet(ctx, walletId)

    // ASSERT
    expect(await ctx.db.accounts.toArray()).toEqual([])
    expect(await ctx.db.wallets.toArray()).toEqual([])
    expect(await ctx.db.settings.get({ key: 'activeAccountId' })).toBeUndefined()
  })

  it('keeps the user wallet that shares the demo public key', async () => {
    // ARRANGE
    expect.assertions(2)
    const ctx = createCtx()
    const userWallet = await walletCreate(ctx, walletInput('Wallet 1'))
    const userAccount = await accountCreate(ctx, accountInput(userWallet, DEMO_PK))
    const demoWallet = await walletCreate(ctx, walletInput('Démo'))
    await accountCreate(ctx, accountInput(demoWallet, DEMO_PK))
    await settingSetValue(ctx, 'activeAccountId', userAccount)

    // ACT
    await demoCleanupWallet(ctx, demoWallet)

    // ASSERT
    const wallets = await ctx.db.wallets.toArray()
    const accounts = await ctx.db.accounts.toArray()
    expect(wallets.map((w) => w.id)).toEqual([userWallet])
    expect(accounts.map((a) => a.id)).toEqual([userAccount])
  })
})

describe('demoCleanupStale', () => {
  it('removes stale Démo wallets but keeps a user wallet named differently', async () => {
    // ARRANGE
    expect.assertions(2)
    const ctx = createCtx()
    const userWallet = await walletCreate(ctx, walletInput('My Wallet'))
    await accountCreate(ctx, accountInput(userWallet, DEMO_PK))
    const stale = await walletCreate(ctx, walletInput('Démo'))
    await accountCreate(ctx, accountInput(stale, DEMO_PK))

    // ACT
    await demoCleanupStale(ctx, DEMO_PK)

    // ASSERT
    const wallets = await ctx.db.wallets.toArray()
    expect(wallets.map((w) => w.id)).toEqual([userWallet])
    expect(await ctx.db.accounts.toArray()).toHaveLength(1)
  })
})
