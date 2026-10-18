import type { DbContext } from '@workspace/db/db-context'
import { env } from '@workspace/env/env'
import { fimsRevokeSession } from '@workspace/solana-client/fims-session'
import { queryClient } from './query-client.tsx'

// Severing the link to an external wallet (disconnect → Watched, or deleting
// the account/wallet) must not leave a live bearer session behind — the token
// would keep working for up to its TTL even though nothing local can use it.
export async function revokeExternalSession(address: string): Promise<void> {
  try {
    await fimsRevokeSession(env('apiEndpoint'), address)
  } catch {
    // revocation is best-effort — the token dies with its TTL regardless
  }
}

// Deleting an account drops its locally cached chain reads and any session
// the address held. Exported for the wallet-delete path, which removes a
// whole wallet's accounts at once.
// NOTE: cleanup is keyed by public key, not account id — a second local
// account watching the same address loses its cache/session too. That is
// benign (it re-syncs on the next read and re-signs on the next 401) but
// not strictly scoped to the deleted row.
export async function accountCleanup(ctx: DbContext, publicKey: string): Promise<void> {
  await ctx.db.chainTransactions.where('address').equals(publicKey).delete()
  // Drop the sync cursor too — re-adding the address must not inherit a stale
  // `{complete: true}` over an empty cache.
  await ctx.db.chainSyncState.delete(publicKey)
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: ['chainAssets', publicKey] }),
    queryClient.invalidateQueries({ queryKey: ['chainHistory', publicKey] }),
  ])
  await revokeExternalSession(publicKey)
}
