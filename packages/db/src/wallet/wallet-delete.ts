import { AppError } from '@workspace/core/app-error'
import { tryCatchOrThrow } from '@workspace/core/try-catch-or-throw'
import { accountFindMany } from '../account/account-find-many.ts'
import type { DbContext } from '../db-context.ts'
import { orderedAccounts } from '../session/resolve-session.ts'
import { settingFindUnique } from '../setting/setting-find-unique.ts'
import { settingSetValue } from '../setting/setting-set-value.ts'
import { walletIsExternal } from './wallet-is-external.ts'

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
    const accounts = await accountFindMany(ctx, { walletId: id })
    // A missing active pointer must not brick deletion — the loader repairs
    // it anyway; treat it as "the active account is not in this wallet".
    const deletesActive = !!activeAccountId && accounts.some((account) => account.id === activeAccountId)
    // External wallets hold no secrets — the row is just a link. Deleting it
    // while active disconnects the wallet and moves active to the next
    // account; the guard only protects real wallets.
    if (deletesActive && !walletIsExternal(wallet)) {
      throw new WalletDeleteActiveError()
    }
    await tryCatchOrThrow(
      ctx.db.accounts.bulkDelete(accounts.map((account) => account.id)),
      `Error deleting accounts for wallet with id ${id}`,
    )
    await tryCatchOrThrow(ctx.db.wallets.delete(id), `Error deleting wallet with id ${id}`)
    if (deletesActive) {
      // Reassign the same fallback the loader/UI would pick — wallet order
      // then account order — so the repair doesn't flip twice.
      const [allAccounts, allWallets] = await Promise.all([ctx.db.accounts.toArray(), ctx.db.wallets.toArray()])
      const remaining = orderedAccounts(allAccounts, allWallets)[0]
      if (remaining) {
        await settingSetValue(ctx, 'activeAccountId', remaining.id)
      } else {
        // Last wallet gone — the root loader sends the app to onboarding.
        // `key` is a unique index, not the primary key — a plain delete(id)
        // would silently miss the row.
        await ctx.db.settings.where('key').equals('activeAccountId').delete()
      }
    }
  })
}
