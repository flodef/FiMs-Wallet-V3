import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { Account } from '@workspace/db/account/account'
import { useAccountMessageSigner } from '@workspace/db-react/use-account-message-signer'
import { useIsAdmin } from '@workspace/db-react/use-is-admin'
import { useSetting } from '@workspace/db-react/use-setting'
import { env } from '@workspace/env/env'
import { useRef } from 'react'
import type {
  FimsAddressBookEntry,
  FimsAddressBookType,
  FimsConfig,
  FimsDashboardMetric,
  FimsHistoricPoint,
  FimsPricePoint,
  FimsToken,
  FimsTransaction,
  FimsUser,
  FimsUserAddress,
  FimsUserHistoricPoint,
  FimsVote,
  FimsVoteKind,
  FimsVoteStatus,
} from '../fims-api.ts'
import {
  FimsApiError,
  fimsBallotMessage,
  fimsGet,
  fimsGetAll,
  fimsLinkAddressMessage,
  fimsSignContent,
  fimsSignedFetch,
  fimsSignedGet,
  fimsSignedGetAll,
} from '../fims-api.ts'

export function useFimsEndpoint() {
  const [apiEndpoint] = useSetting('apiEndpoint')
  // The apiEndpoint override is admin-only: a rogue endpoint can serve poisoned
  // data (e.g. a fake address book) even though it cannot replay signatures.
  const isAdmin = useIsAdmin()
  return isAdmin ? (apiEndpoint ?? env('apiEndpoint')) : env('apiEndpoint')
}

export function useFimsUsers(params?: { address?: string }) {
  const apiEndpoint = useFimsEndpoint()
  return useQuery({
    queryFn: () => fimsGetAll<FimsUser>(apiEndpoint, '/users', params),
    queryKey: ['fims', 'users', params?.address],
  })
}

// Member-scoped reads are signed when an account is provided: the API only
// serves a private member's data to the owner (signed) or an admin. Signing
// failures (e.g. locked vault, watched account) fall back to anonymous reads.
export function useFimsSignedGet(account: Account | undefined) {
  const apiEndpoint = useFimsEndpoint()
  const messageSigner = useAccountMessageSigner()
  return async <T,>(path: string, params?: Record<string, string>): Promise<T> => {
    if (!account || account.type === 'Watched') return fimsGet<T>(apiEndpoint, path, params)
    try {
      const signer = await messageSigner(account)
      return await fimsSignedGet<T>(apiEndpoint, signer, path, params)
    } catch (error) {
      if (error instanceof FimsApiError) throw error
      return fimsGet<T>(apiEndpoint, path, params)
    }
  }
}

// Same fallback logic as useFimsSignedGet, but walks every page so callers
// keep receiving full datasets now that list endpoints are paginated.
export function useFimsSignedGetAll(account: Account | undefined) {
  const apiEndpoint = useFimsEndpoint()
  const messageSigner = useAccountMessageSigner()
  return async <T,>(path: string, params?: Record<string, string>): Promise<T[]> => {
    if (!account || account.type === 'Watched') return fimsGetAll<T>(apiEndpoint, path, params)
    try {
      const signer = await messageSigner(account)
      return await fimsSignedGetAll<T>(apiEndpoint, signer, path, params)
    } catch (error) {
      if (error instanceof FimsApiError) throw error
      return fimsGetAll<T>(apiEndpoint, path, params)
    }
  }
}

export function useFimsMember(address: string, account?: Account, enabled = true) {
  const signedGet = useFimsSignedGet(account)
  const users = useQuery({
    // The query is SIGNED — firing it before the user consented would leak
    // "signer X reads target Y" to the API for any watched/custom address.
    enabled,
    queryFn: () => signedGet<FimsUser[]>('/users', { address }),
    queryKey: ['fims', 'users', address, account?.publicKey ?? 'anon'],
  })
  return { ...users, member: users.data?.[0] ?? null }
}

export function useFimsTransactions(params?: { userId?: number }, account?: Account, enabled = true) {
  const signedGetAll = useFimsSignedGetAll(account)
  return useQuery({
    // Without enabled the query still fires with no userId — the API then
    // returns every transaction the signer can see, an unbounded paginated
    // fetch whose rows must never leak into per-address calculations.
    enabled,
    queryFn: () =>
      signedGetAll<FimsTransaction>('/transactions', {
        ...(params?.userId ? { userId: String(params.userId) } : {}),
      }),
    queryKey: ['fims', 'transactions', params?.userId, account?.publicKey ?? 'anon'],
  })
}

export function useFimsDashboard() {
  const apiEndpoint = useFimsEndpoint()
  return useQuery({
    queryFn: () => fimsGet<FimsDashboardMetric[]>(apiEndpoint, '/dashboard'),
    queryKey: ['fims', 'dashboard'],
  })
}

export function useFimsTokens() {
  const apiEndpoint = useFimsEndpoint()
  return useQuery({
    queryFn: () => fimsGetAll<FimsToken>(apiEndpoint, '/tokens'),
    queryKey: ['fims', 'tokens'],
  })
}

export function useFimsHistoric() {
  const apiEndpoint = useFimsEndpoint()
  return useQuery({
    queryFn: () => fimsGetAll<FimsHistoricPoint>(apiEndpoint, '/historic'),
    queryKey: ['fims', 'historic'],
  })
}

export function useFimsUserHistoric(userId: number | undefined, account?: Account) {
  const signedGetAll = useFimsSignedGetAll(account)
  return useQuery({
    enabled: userId != null,
    queryFn: () => signedGetAll<FimsUserHistoricPoint>('/user-historic', { userId: String(userId) }),
    queryKey: ['fims', 'user-historic', userId, account?.publicKey ?? 'anon'],
  })
}

export function useFimsPrices(token?: string) {
  const apiEndpoint = useFimsEndpoint()
  return useQuery({
    queryFn: () => fimsGetAll<FimsPricePoint>(apiEndpoint, '/prices', token ? { token } : {}),
    queryKey: ['fims', 'prices', token],
  })
}

export function useFimsAddressBook(userId: number | undefined, account?: Account) {
  const signedGetAll = useFimsSignedGetAll(account)
  return useQuery({
    enabled: userId != null,
    queryFn: () => signedGetAll<FimsAddressBookEntry>('/address-book', { userId: String(userId) }),
    queryKey: ['fims', 'address-book', userId, account?.publicKey ?? 'anon'],
  })
}

// Signed mutations — the active account's keypair authenticates the request.
export function useFimsSignedFetch(account: Account) {
  const apiEndpoint = useFimsEndpoint()
  const messageSigner = useAccountMessageSigner()
  return async <T,>(method: 'DELETE' | 'PATCH' | 'POST', path: string, body?: unknown): Promise<T> => {
    const signer = await messageSigner(account)
    return fimsSignedFetch<T>(apiEndpoint, signer, method, path, body)
  }
}

export function useFimsAddressBookCreate(account: Account, userId: number) {
  const signedFetch = useFimsSignedFetch(account)
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: { address: string; label: string; type: FimsAddressBookType }) =>
      signedFetch<FimsAddressBookEntry>('POST', '/address-book', { ...input, userId }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['fims', 'address-book', userId] }),
  })
}

export function useFimsAddressBookUpdate(account: Account, userId: number) {
  const signedFetch = useFimsSignedFetch(account)
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id, ...input }: { address?: string; id: number; label?: string; type?: FimsAddressBookType }) =>
      signedFetch<FimsAddressBookEntry>('PATCH', `/address-book/${id}`, input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['fims', 'address-book', userId] }),
  })
}

export function useFimsUserUpdate(account: Account, userId: number) {
  const signedFetch = useFimsSignedFetch(account)
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: { isPublic?: boolean; name?: string; riskTarget?: null | number }) =>
      signedFetch<FimsUser>('PATCH', `/users/${userId}`, input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['fims', 'users'] })
    },
  })
}

// Signed when possible so the API can answer myOptionId for the caller.
export function useFimsVotes(account?: Account) {
  const signedGet = useFimsSignedGet(account)
  return useQuery({
    queryFn: () => signedGet<FimsVote[]>('/votes'),
    queryKey: ['fims', 'votes', account?.publicKey ?? 'anon'],
  })
}

// Free tontine donation: after the on-chain send to the tontine wallet the
// API verifies the transaction (tontine actually credited, sender linked to
// the member) and writes the donation rows the weight/debt accounting reads.
export function useFimsRecordDonation(account: Account) {
  const signedFetch = useFimsSignedFetch(account)
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (signature: string) => signedFetch<FimsTransaction[]>('POST', '/donations', { signature }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['fims', 'transactions'] })
      queryClient.invalidateQueries({ queryKey: ['fims', 'user-historic'] })
    },
  })
}

export function useFimsCastBallot(account: Account, voteId: number) {
  const signedFetch = useFimsSignedFetch(account)
  const messageSigner = useAccountMessageSigner()
  const queryClient = useQueryClient()
  return useMutation({
    // Every ballot is a signed message: free for the member, non-replayable
    // for the community — the API verifies it against the canonical text.
    mutationFn: async (optionId: number) => {
      const ts = Date.now()
      const nonce = crypto.randomUUID()
      const signed = await fimsSignContent(
        await messageSigner(account),
        fimsBallotMessage(voteId, optionId, account.publicKey, ts, nonce),
      )
      return signedFetch<FimsVote>('POST', `/votes/${voteId}/ballot`, {
        nonce,
        optionId,
        signature: signed.signature,
        signedMessage: signed.signedMessage,
        ts,
      })
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['fims', 'votes'] }),
  })
}

export function useFimsVoteCreate(account: Account) {
  const signedFetch = useFimsSignedFetch(account)
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: {
      closesAt?: string | undefined
      description?: string | undefined
      kind: FimsVoteKind
      options: string[]
      title: string
    }) => signedFetch<FimsVote>('POST', '/votes', input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['fims', 'votes'] }),
  })
}

export function useFimsVoteUpdate(account: Account, voteId: number) {
  const signedFetch = useFimsSignedFetch(account)
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: { status: FimsVoteStatus }) => signedFetch<FimsVote>('PATCH', `/votes/${voteId}`, input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['fims', 'votes'] }),
  })
}

// Public runtime config — the proposal threshold (admin-tunable) and the
// total invested amount the eligibility check divides by.
export function useFimsConfig() {
  const apiEndpoint = useFimsEndpoint()
  return useQuery({
    queryFn: () => fimsGet<FimsConfig>(apiEndpoint, '/config'),
    queryKey: ['fims', 'config'],
  })
}

export function useFimsUpdateConfig(account: Account) {
  const signedFetch = useFimsSignedFetch(account)
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: { proposalThreshold: number }) => signedFetch<FimsConfig>('PATCH', '/config', input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['fims', 'config'] }),
  })
}

// Rebalance: converts `eurAmount` of `fromToken` into `toToken` — the API
// prices the units server-side and writes the two `conversion` transactions.
// requestId is generated once per mutation so network retries of the same
// call are deduplicated server-side instead of double-applying the pair.
export function useFimsConvert(account: Account) {
  const signedFetch = useFimsSignedFetch(account)
  const queryClient = useQueryClient()
  // The id is minted once per mutation lifecycle (not per mutationFn call):
  // TanStack retries re-invoke mutationFn, and those retries must carry the
  // SAME requestId for the server-side dedup to bite.
  const requestId = useRef('')
  return useMutation({
    mutationFn: (input: { eurAmount: number; fromToken: string; toToken: string }) => {
      if (!requestId.current) {
        requestId.current = crypto.randomUUID()
      }
      return signedFetch<FimsTransaction[]>('POST', '/conversions', { ...input, requestId: requestId.current })
    },
    onSettled: () => {
      requestId.current = ''
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['fims', 'transactions'] }),
  })
}

export function useFimsAddressBookDelete(account: Account, userId: number) {
  const signedFetch = useFimsSignedFetch(account)
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: number) => signedFetch<string>('DELETE', `/address-book/${id}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['fims', 'address-book', userId] }),
  })
}

// Multi-wallet members: one user, several wallets. When an address is unknown
// to the API the member page proposes a name — three outcomes:
//   name free                 → self-register (POST /users)
//   name taken, ours          → link the wallet to that member (both wallets
//                               sign: request by an already-linked account,
//                               consent by the new one)
//   name taken, not ours      → server-side uniqueness rejects it
export function useFimsUserClaim(account: Account, accounts: Account[]) {
  const apiEndpoint = useFimsEndpoint()
  const messageSigner = useAccountMessageSigner()
  const signedGet = useFimsSignedGet(account)
  const queryClient = useQueryClient()
  const signerOf = async (a: Account) => messageSigner(a)
  return useMutation({
    mutationFn: async (name: string) => {
      const matches = await signedGet<FimsUser[]>('/users', { name })
      const existing = matches.find((u) => u.name.toLowerCase() === name.toLowerCase())
      if (!existing) {
        const signer = await signerOf(account)
        const user = await fimsSignedFetch<FimsUser>(apiEndpoint, signer, 'POST', '/users', {
          address: account.publicKey,
          name,
        })
        return { action: 'registered' as const, user }
      }
      const linkedAccount = accounts.find((a) => (existing.addresses ?? [existing.address]).includes(a.publicKey))
      if (!linkedAccount) {
        // The name belongs to someone else — or to us on a wallet not
        // imported here. Either way this wallet cannot prove ownership.
        throw new FimsApiError(403, `name already taken: ${name}`)
      }
      const consent = await fimsSignContent(
        await signerOf(account),
        fimsLinkAddressMessage(existing.id, account.publicKey),
      )
      await fimsSignedFetch<FimsUserAddress>(
        apiEndpoint,
        await signerOf(linkedAccount),
        'POST',
        `/users/${existing.id}/addresses`,
        {
          address: account.publicKey,
          signature: consent.signature,
          signedMessage: consent.signedMessage,
        },
      )
      return { action: 'linked' as const, user: existing }
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['fims'] }),
  })
}
