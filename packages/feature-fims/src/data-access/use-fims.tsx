import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { Account } from '@workspace/db/account/account'
import { useAccountSecretKey } from '@workspace/db-react/use-account-secret-key'
import { useSetting } from '@workspace/db-react/use-setting'
import { env } from '@workspace/env/env'
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
} from '../fims-api.ts'
import { FimsApiError, fimsGet, fimsSignedFetch, fimsSignedGet } from '../fims-api.ts'

export function useFimsEndpoint() {
  const [apiEndpoint] = useSetting('apiEndpoint')
  return apiEndpoint ?? env('apiEndpoint')
}

export function useFimsUsers(params?: { address?: string }) {
  const apiEndpoint = useFimsEndpoint()
  return useQuery({
    queryFn: () => fimsGet<FimsUser[]>(apiEndpoint, '/users', params),
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

export function useFimsMember(address: string, account?: Account) {
  const signedGet = useFimsSignedGet(account)
  const users = useQuery({
    queryFn: () => signedGet<FimsUser[]>('/users', { address }),
    queryKey: ['fims', 'users', address, account?.publicKey ?? 'anon'],
  })
  return { ...users, member: users.data?.[0] ?? null }
}

export function useFimsTransactions(params?: { userId?: number }, account?: Account) {
  const signedGet = useFimsSignedGet(account)
  return useQuery({
    queryFn: () =>
      signedGet<FimsTransaction[]>('/transactions', {
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
    queryFn: () => fimsGet<FimsToken[]>(apiEndpoint, '/tokens'),
    queryKey: ['fims', 'tokens'],
  })
}

export function useFimsHistoric() {
  const apiEndpoint = useFimsEndpoint()
  return useQuery({
    queryFn: () => fimsGet<FimsHistoricPoint[]>(apiEndpoint, '/historic'),
    queryKey: ['fims', 'historic'],
  })
}

export function useFimsUserHistoric(userId: number | undefined, account?: Account) {
  const signedGet = useFimsSignedGet(account)
  return useQuery({
    enabled: userId != null,
    queryFn: () => signedGet<FimsUserHistoricPoint[]>('/user-historic', { userId: String(userId) }),
    queryKey: ['fims', 'user-historic', userId, account?.publicKey ?? 'anon'],
  })
}

export function useFimsPrices(token?: string) {
  const apiEndpoint = useFimsEndpoint()
  return useQuery({
    queryFn: () => fimsGet<FimsPricePoint[]>(apiEndpoint, '/prices', token ? { token } : {}),
    queryKey: ['fims', 'prices', token],
  })
}

export function useFimsAddressBook(userId: number | undefined, account?: Account) {
  const signedGet = useFimsSignedGet(account)
  return useQuery({
    enabled: userId != null,
    queryFn: () => signedGet<FimsAddressBookEntry[]>('/address-book', { userId: String(userId) }),
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

export function useFimsAddressBookDelete(account: Account, userId: number) {
  const signedFetch = useFimsSignedFetch(account)
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: number) => signedFetch<string>('DELETE', `/address-book/${id}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['fims', 'address-book', userId] }),
  })
}
