import type { DbContext } from '../db-context.ts'
import { accountFindUnique } from './account-find-unique.ts'
import type { AccountUpdateInput } from './account-update-input.ts'
import { accountUpdateSchema } from './account-update-schema.ts'

// Partial update where an explicit `undefined` field DELETES the property
// (Dexie `.update` would store a literal undefined otherwise). Used to flip
// Connected <-> Watched: disconnecting clears `externalWallet` so the
// account falls back to watch-only without losing its history.
export async function accountUpdate(ctx: DbContext, id: string, input: AccountUpdateInput) {
  const parsed = accountUpdateSchema.parse(input)
  return ctx.db.transaction('rw', ctx.db.accounts, async () => {
    const found = await accountFindUnique(ctx, id)
    if (!found) {
      throw new Error(`Account with id ${id} not found`)
    }
    await ctx.db.accounts
      .where('id')
      .equals(id)
      .modify((account) => {
        for (const [key, value] of Object.entries(parsed)) {
          if (value === undefined) {
            delete (account as Record<string, unknown>)[key]
          } else {
            ;(account as Record<string, unknown>)[key] = value
          }
        }
        account.updatedAt = new Date()
      })
  })
}
