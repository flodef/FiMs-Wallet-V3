import { AppError } from '@workspace/core/app-error'
import { tryCatchOrThrow } from '@workspace/core/try-catch-or-throw'
import { decryptWithVaultKey } from '@workspace/vault/encrypted-value'
import type { DbContext } from '../db-context.ts'

export async function accountReadSecretKey(ctx: DbContext, id: string): Promise<string> {
  const account = await ctx.db.transaction('r', ctx.db.accounts, async () => {
    const account = await tryCatchOrThrow(
      ctx.db.accounts.where('id').equals(id).raw().first(),
      `Error finding account with id ${id}`,
    )
    if (!account) {
      throw new AppError('accountNotFound', `Account with id ${id} not found`, { id })
    }
    if (account.type === 'Watched' || account.type === 'Connected') {
      throw new AppError('secretKeyMissingExternal', `Account with id ${id} does not have a secret key`, { id })
    }
    if (!account.secretKey) {
      throw new AppError('secretKeyMissing', `Account with id ${id} does not have a secret key`, { id })
    }
    return { secretKey: account.secretKey, walletId: account.walletId }
  })

  return await decryptWithVaultKey({
    encrypted: account.secretKey,
    key: await ctx.vault.requireWalletKey({ walletId: account.walletId }),
  })
}
