import type { MessagePartialSigner } from '@solana/kit'
import { queryOptions, useQuery } from '@tanstack/react-query'
import { useAppContext } from '@workspace/context-react/use-app-context'
import type { Account } from '@workspace/db/account/account'
import type { Database } from '@workspace/db/database'
import { useAccountMessageSigner } from '@workspace/db-react/use-account-message-signer'
import { useAccountsLive } from '@workspace/db-react/use-accounts-live'
import { useCallback, useSyncExternalStore } from 'react'
import { chainGetAssets, chainGetHistory, chainGetLabels } from './chain-api.ts'

const PAGE_SIZE = 100
// Per-run page budget shared by the newest pass and the backfill — the next
// refetch resumes where this run stopped instead of leaving gaps forever.
const MAX_PAGES = 10

// Incremental sync in two phases over the same page walk:
//  1. newest → stop at the first signature already cached;
//  2. if the backfill never finished, keep paging past the cached region —
//     Helius `cursor` just continues into older history — until the budget
//     runs out or the API stops handing out cursors (history fully fetched).
// The resume point persists in `chainSyncState` so a cut sync (closed tab,
// API down) resumes instead of never reaching old transactions.
async function syncChainHistory(db: Database, signer: MessagePartialSigner, address: string): Promise<boolean> {
  const state = await db.chainSyncState.get(address)
  if (state?.complete) {
    // Only top-up new transactions — the old history is fully cached.
    await syncNewest(db, signer, address)
    return true
  }
  // Composite PK [address, signature] — the query already filtered on address.
  const cached = await db.chainTransactions.where('address').equals(address).primaryKeys()
  const known = new Set(cached.map((key) => key[1]))
  let cursor: string | undefined
  let resume = state?.oldestCursor ?? undefined
  let complete = false
  for (let page = 0; page < MAX_PAGES; page++) {
    const res = await chainGetHistory(signer, address, { cursor, limit: PAGE_SIZE })
    const rows = res.transactions
    const fresh = rows.filter((tx) => !known.has(tx.signature))
    if (fresh.length) {
      await db.chainTransactions.bulkPut(fresh.map((tx) => ({ ...tx, address })))
      for (const tx of fresh) known.add(tx.signature)
    }
    if (!res.cursor) {
      // End of history — only now is `complete` allowed.
      complete = true
      break
    }
    if (fresh.length !== rows.length && resume && resume !== cursor) {
      // Reached the cached region — jump straight to the persisted resume
      // point instead of re-paging rows we already have.
      cursor = resume
      resume = undefined
      continue
    }
    // Keep paging through the cached region: pre-upgrade caches have the
    // newest N pages and NO resume point, so stopping here would mark a
    // truncated history `complete` forever. Inserts are idempotent anyway.
    cursor = res.cursor
  }
  await db.chainSyncState.put({ address, complete, oldestCursor: complete ? null : (cursor ?? null) })
  return complete
}

// Top-up pass used once history is fully backfilled: walk newest→oldest and
// stop at the first known signature — everything older is already cached.
async function syncNewest(db: Database, signer: MessagePartialSigner, address: string): Promise<void> {
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
    if (!res.cursor || fresh.length !== rows.length) return
    cursor = res.cursor
  }
  // Exhausted MAX_PAGES still inside a fresh region (>MAX_PAGES×100 txs
  // between syncs): dropping the flag would mark a truncated history
  // complete forever. Persist the frontier — the next incomplete sync
  // re-walks the newest rows (now cached), jumps to this cursor via the
  // resume path and continues deeper, one window per pass.
  await db.chainSyncState.put({ address, complete: false, oldestCursor: cursor ?? null })
}

const consentListeners = new Set<() => void>()

// Reading an address signed by a DIFFERENT account leaks the link
// "signer X reads target Y" to the API — so it only happens after an
// explicit click. Consent is remembered per (signer, target) pair for the
// session: revoking/forgetting is just closing the tab.
const consentKey = (signer: string, target: string) => `chainReadConsent|${signer}|${target}`

function consented(signer: string, target: string): boolean {
  if (signer === target) return true
  try {
    return sessionStorage.getItem(consentKey(signer, target)) === '1'
  } catch {
    return false
  }
}

export function useChainReadConsent(signerAccount: Account | undefined, target: null | string) {
  const subscribe = useCallback((onChange: () => void) => {
    consentListeners.add(onChange)
    return () => consentListeners.delete(onChange)
  }, [])
  const granted = useSyncExternalStore(subscribe, () =>
    signerAccount && target ? consented(signerAccount.publicKey, target) : true,
  )
  const needed = !!signerAccount && !!target && !granted
  // `override` lets the caller pass the freshest target: clicking "grant"
  // blurs the custom-address input, and the blur updates `address` AFTER
  // this callback already captured the old one — consenting for the stale
  // target would force a second click.
  const grant = useCallback(
    (override?: string) => {
      const resolved = override ?? target
      if (!signerAccount || !resolved) return
      try {
        sessionStorage.setItem(consentKey(signerAccount.publicKey, resolved), '1')
      } catch {
        // storage unavailable — consent simply won't persist
      }
      for (const listener of consentListeners) listener()
    },
    [signerAccount, target],
  )
  return { grant, needed }
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
      let complete: boolean
      try {
        complete = await syncChainHistory(db, signer, address)
      } catch (error) {
        const cached = await db.chainTransactions.where('address').equals(address).count()
        if (!cached) throw error
        complete = (await db.chainSyncState.get(address))?.complete ?? false
      }
      const rows = await db.chainTransactions.where('address').equals(address).sortBy('timestamp')
      return { complete, transactions: rows.reverse() } // newest first
    },
    queryKey: ['chainHistory', address],
  })
}

export function useChainHistory({
  account,
  address,
  enabled = true,
}: {
  account: Account
  address: null | string
  enabled?: boolean
}) {
  const ctx = useAppContext()
  const signerFor = useAccountMessageSigner()
  const signerAccount = useChainSignerAccount(account)
  return useQuery({
    ...chainHistoryQueryOptions({ address: address ?? '', db: ctx.db, signerAccount, signerFor }),
    enabled: enabled && Boolean(address) && !!signerAccount,
  })
}

export function useChainAssets({
  account,
  address,
  enabled = true,
}: {
  account: Account
  address: null | string
  enabled?: boolean
}) {
  const signerFor = useAccountMessageSigner()
  const signerAccount = useChainSignerAccount(account)
  return useQuery({
    enabled: enabled && Boolean(address) && !!signerAccount,
    queryFn: async () => {
      if (!signerAccount) throw new Error('No signing-capable account')
      return chainGetAssets(await signerFor(signerAccount), address ?? '')
    },
    queryKey: ['chainAssets', address],
  })
}
