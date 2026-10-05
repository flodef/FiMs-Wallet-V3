import type { MessagePartialSigner } from '@solana/kit'
import { queryOptions, useQuery } from '@tanstack/react-query'
import { useAppContext } from '@workspace/context-react/use-app-context'
import type { Account } from '@workspace/db/account/account'
import type { Database } from '@workspace/db/database'
import { useAccountMessageSigner } from '@workspace/db-react/use-account-message-signer'
import { chainGetAssets, chainGetHistory, chainGetLabels } from './chain-api.ts'

const PAGE_SIZE = 100
const MAX_PAGES = 10

// Incremental sync: Helius pages newest→oldest via `cursor`. We walk pages
// until we hit a signature already in Dexie — the rest of the history is
// cached — or a short page marks the end. Only the delta is fetched.
async function syncChainHistory(db: Database, signer: MessagePartialSigner, address: string): Promise<void> {
  // Composite PK [address, signature] — the query already filtered on address.
  const cached = await db.chainTransactions.where('address').equals(address).primaryKeys()
  const known = new Set(cached.map((key) => key[1]))
  let cursor: string | undefined
  for (let page = 0; page < MAX_PAGES; page++) {
    const res = await chainGetHistory(signer, address, { cursor, limit: PAGE_SIZE })
    const rows = res.transactions
    const fresh = rows.filter((tx) => !known.has(tx.signature))
    if (fresh.length) {
      await db.chainTransactions.bulkPut(fresh.map((tx) => ({ ...tx, address })))
    }
    // Hit already-cached history → done; no cursor → end of history.
    if (!res.cursor || fresh.length !== rows.length) return
    cursor = res.cursor
  }
}

export function useChainLabels({ account }: { account: Account }) {
  const signerFor = useAccountMessageSigner()
  return useQuery({
    enabled: account.type !== 'Watched',
    queryFn: async () => chainGetLabels(await signerFor(account)),
    queryKey: ['chainLabels'],
    staleTime: 5 * 60 * 1000,
  })
}

function chainHistoryQueryOptions({
  account,
  address,
  db,
  signerFor,
}: {
  account: Account
  address: string
  db: Database
  signerFor: (account: Account) => Promise<MessagePartialSigner>
}) {
  return queryOptions({
    queryFn: async () => {
      const signer = await signerFor(account)
      // Sync failure (API down, rate limit) must not blank cached history —
      // that's the point of the local store. Empty cache → error surfaces.
      try {
        await syncChainHistory(db, signer, address)
      } catch (error) {
        const cached = await db.chainTransactions.where('address').equals(address).count()
        if (!cached) throw error
      }
      const rows = await db.chainTransactions.where('address').equals(address).sortBy('timestamp')
      return rows.reverse() // newest first
    },
    queryKey: ['chainHistory', address],
  })
}

export function useChainHistory({ account, address }: { account: Account; address: null | string }) {
  const ctx = useAppContext()
  const signerFor = useAccountMessageSigner()
  return useQuery({
    ...chainHistoryQueryOptions({ account, address: address ?? '', db: ctx.db, signerFor }),
    enabled: Boolean(address) && account.type !== 'Watched',
  })
}

export function useChainAssets({ account, address }: { account: Account; address: null | string }) {
  const signerFor = useAccountMessageSigner()
  return useQuery({
    enabled: Boolean(address) && account.type !== 'Watched',
    queryFn: async () => chainGetAssets(await signerFor(account), address ?? ''),
    queryKey: ['chainAssets', address],
  })
}
