import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { Account } from '@workspace/db/account/account'
import { useAccountSecretKey } from '@workspace/db-react/use-account-secret-key'
import { useAccountsLive } from '@workspace/db-react/use-accounts-live'
import { useSetting } from '@workspace/db-react/use-setting'
import { env, envAdminAddresses } from '@workspace/env/env'
import { createKeyPairSignerFromJson } from '@workspace/keypair/create-key-pair-signer-from-json'
import type {
  FimsAddressBookEntry,
  FimsAddressBookType,
  FimsDashboardMetric,
  FimsHistoricPoint,
  FimsPricePoint,
  FimsToken,
  FimsTransaction,
  FimsUser,
  FimsUserHistoricPoint,
  FimsVote,
  FimsVoteKind,
  FimsVoteStatus,
} from '../fims-api.ts'
import { FimsApiError, fimsGet, fimsGetAll, fimsSignedFetch, fimsSignedGet, fimsSignedGetAll } from '../fims-api.ts'

export function useFimsEndpoint() {
  const [apiEndpoint] = useSetting('apiEndpoint')
  // The apiEndpoint override is admin-only: a rogue endpoint can serve poisoned
  // data (e.g. a fake address book) even though it cannot replay signatures.
  const accounts = useAccountsLive()
  const [activeAccountId] = useSetting('activeAccountId')
  const active = accounts.find((account) => account.id === activeAccountId)
  const isAdmin = !!active && envAdminAddresses().includes(active.publicKey)
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
  const accountSecretKey = useAccountSecretKey()
  return async <T,>(path: string, params?: Record<string, string>): Promise<T> => {
    if (!account || account.type === 'Watched') return fimsGet<T>(apiEndpoint, path, params)
    try {
      const json = await accountSecretKey({ account })
      const signer = await createKeyPairSignerFromJson({ json })
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
  const accountSecretKey = useAccountSecretKey()
  return async <T,>(path: string, params?: Record<string, string>): Promise<T[]> => {
    if (!account || account.type === 'Watched') return fimsGetAll<T>(apiEndpoint, path, params)
    try {
      const json = await accountSecretKey({ account })
      const signer = await createKeyPairSignerFromJson({ json })
      return await fimsSignedGetAll<T>(apiEndpoint, signer, path, params)
    } catch (error) {
      if (error instanceof FimsApiError) throw error
      return fimsGetAll<T>(apiEndpoint, path, params)
    }
  }
}

export function useFimsMember(address: string, account?: Account) {
  const signedGet = useFimsSignedGet(account)
  const users = useQuery({
    queryFn: () => signedGet<FimsUser[]>('/users', { address }),
    queryKey: ['fims', 'users', address, account?.publicKey ?? 'anon'],
  })
  return { ...users, member: users.data?.[0] ?? null }
}

export function useFimsTransactions(params?: { userId?: number }, account?: Account) {
  const signedGetAll = useFimsSignedGetAll(account)
  return useQuery({
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
  const accountSecretKey = useAccountSecretKey()
  return async <T,>(method: 'DELETE' | 'PATCH' | 'POST', path: string, body?: unknown): Promise<T> => {
    const json = await accountSecretKey({ account })
    const signer = await createKeyPairSignerFromJson({ json })
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

export function useFimsCastBallot(account: Account, voteId: number) {
  const signedFetch = useFimsSignedFetch(account)
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (optionId: number) => signedFetch<FimsVote>('POST', `/votes/${voteId}/ballot`, { optionId }),
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

// Rebalance: converts `eurAmount` of `fromToken` into `toToken` — the API
// prices the units server-side and writes the two `conversion` transactions.
export function useFimsConvert(account: Account) {
  const signedFetch = useFimsSignedFetch(account)
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: { eurAmount: number; fromToken: string; toToken: string }) =>
      signedFetch<FimsTransaction[]>('POST', '/conversions', input),
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
