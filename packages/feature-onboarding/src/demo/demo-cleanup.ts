import type { DbContext } from '@workspace/db/db-context'

// Deletes the demo wallet and its accounts — keyed by wallet id, never by
// public key: the demo mnemonic can collide with a user-imported seed, and a
// pubkey lookup would then pick (and delete!) the user's own wallet.
export async function demoCleanupWallet(ctx: DbContext, walletId: string): Promise<void> {
  try {
    await ctx.db.transaction('rw', ctx.db.accounts, ctx.db.wallets, ctx.db.settings, async () => {
      const accounts = await ctx.db.accounts
        .orderBy('order')
        .filter((account) => account.walletId === walletId)
        .toArray()
      await ctx.db.accounts.bulkDelete(accounts.map((account) => account.id))
      await ctx.db.wallets.delete(walletId)
      // The demo wallet may have been the active one (fresh install): clear
      // the pointer if it dangles, else useAccountActive throws everywhere.
      const activeSetting = await ctx.db.settings.get({ key: 'activeAccountId' })
      if (activeSetting && !(await ctx.db.accounts.get(activeSetting.value))) {
        await ctx.db.settings.delete(activeSetting.id)
      }
    })
  } catch (error) {
    console.warn('demoCleanupWallet failed', error)
  }
}

// Leftover 'Démo' wallets from interrupted runs share the public mnemonic —
// a public-key match plus the fixed wallet name identifies them. A wallet the
// user imported from that seed and named differently is never touched.
export async function demoCleanupStale(ctx: DbContext, publicKey: string, keepWalletId?: null | string) {
  const accounts = await ctx.db.accounts.where('publicKey').equals(publicKey).toArray()
  const walletIds = [...new Set(accounts.map((account) => account.walletId))]
  for (const walletId of walletIds) {
    if (walletId === keepWalletId) {
      continue
    }
    const wallet = await ctx.db.wallets.get(walletId)
    if (wallet?.name === 'Démo') {
      await demoCleanupWallet(ctx, walletId)
    }
  }
}
