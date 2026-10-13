import { AppError, NoActiveAccountError } from '@workspace/core/app-error'
import { tryCatchOrThrow } from '@workspace/core/try-catch-or-throw'
import { accountFindMany } from '../account/account-find-many.ts'
import type { DbContext } from '../db-context.ts'
import { settingFindUnique } from '../setting/setting-find-unique.ts'
import { settingSetValue } from '../setting/setting-set-value.ts'

// Tagged so the UI can localize it — raw error.message is English-only.
export class WalletDeleteActiveError extends AppError {
  constructor() {
    super('walletDeleteActive', 'You cannot delete the active wallet. Please change wallets and try again.')
  }
}

export async function walletDelete(ctx: DbContext, id: string): Promise<void> {
  return ctx.db.transaction('rw', ctx.db.accounts, ctx.db.settings, ctx.db.wallets, async () => {
    const wallet = await tryCatchOrThrow(ctx.db.wallets.get(id), `Error finding wallet with id ${id}`)
    if (!wallet) {
      throw new AppError('walletNotFound', `Wallet with id ${id} not found`, { id })
    }
    const activeAccountId = (await settingFindUnique(ctx, 'activeAccountId'))?.value
    if (!activeAccountId) {
      throw new NoActiveAccountError()
    }
    const accounts = await accountFindMany(ctx, { walletId: id })
    const deletesActive = accounts.some((account) => account.id === activeAccountId)
    // External wallets hold no secrets — the row is just a link. Deleting it
    // while active disconnects the wallet and moves active to the next
    // account; the guard only protects real wallets. Rows written before
    // `externalWallet` was persisted are external by their empty
    // derivationPath.
    const isExternal = !!wallet.externalWallet || wallet.derivationPath.length === 0
    if (deletesActive && !isExternal) {
      throw new WalletDeleteActiveError()
    }
    await tryCatchOrThrow(
      ctx.db.accounts.bulkDelete(accounts.map((account) => account.id)),
      `Error deleting accounts for wallet with id ${id}`,
    )
    await tryCatchOrThrow(ctx.db.wallets.delete(id), `Error deleting wallet with id ${id}`)
    if (deletesActive) {
      const remaining = await ctx.db.accounts.toCollection().first()
      if (remaining) {
        await settingSetValue(ctx, 'activeAccountId', remaining.id)
      } else {
        // Last wallet gone — the root loader sends the app to onboarding.
        await ctx.db.settings.delete('activeAccountId')
      }
    }
  })
}
