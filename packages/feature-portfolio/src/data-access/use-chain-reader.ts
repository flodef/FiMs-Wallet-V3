import type { MessagePartialSigner } from '@solana/kit'
import { queryOptions, useQuery } from '@tanstack/react-query'
import { useAppContext } from '@workspace/context-react/use-app-context'
import type { Account } from '@workspace/db/account/account'
import type { Database } from '@workspace/db/database'
import { useAccountMessageSigner } from '@workspace/db-react/use-account-message-signer'
import { useAccountsLive } from '@workspace/db-react/use-accounts-live'
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

// The chain API needs a signed session but the signed address does not
// have to be the watched target — any signing-capable account works.
// External (Connected) signers are preferred: they sign without unlocking
// the vault, exactly like a plain session read.
export function useChainSignerAccount(account: Account): Account | undefined {
  const accounts = useAccountsLive()
  return account.type !== 'Watched'
    ? account
    : (accounts.find((item) => item.type === 'Connected') ?? accounts.find((item) => item.type !== 'Watched'))
}

export function useChainLabels({ account }: { account: Account }) {
  const signerFor = useAccountMessageSigner()
  const signerAccount = useChainSignerAccount(account)
  return useQuery({
    enabled: !!signerAccount,
    queryFn: async () => {
      if (!signerAccount) throw new Error('No signing-capable account')
      return chainGetLabels(await signerFor(signerAccount))
    },
    queryKey: ['chainLabels'],
    staleTime: 5 * 60 * 1000,
  })
}

function chainHistoryQueryOptions({
  address,
  db,
  signerFor,
  signerAccount,
}: {
  address: string
  db: Database
  signerFor: (account: Account) => Promise<MessagePartialSigner>
  signerAccount: Account | undefined
}) {
  return queryOptions({
    queryFn: async () => {
      if (!signerAccount) throw new Error('No signing-capable account')
      const signer = await signerFor(signerAccount)
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
  const signerAccount = useChainSignerAccount(account)
  return useQuery({
    ...chainHistoryQueryOptions({ address: address ?? '', db: ctx.db, signerAccount, signerFor }),
    enabled: Boolean(address) && !!signerAccount,
  })
}

export function useChainAssets({ account, address }: { account: Account; address: null | string }) {
  const signerFor = useAccountMessageSigner()
  const signerAccount = useChainSignerAccount(account)
  return useQuery({
    enabled: Boolean(address) && !!signerAccount,
    queryFn: async () => {
      if (!signerAccount) throw new Error('No signing-capable account')
      return chainGetAssets(await signerFor(signerAccount), address ?? '')
    },
    queryKey: ['chainAssets', address],
  })
}
