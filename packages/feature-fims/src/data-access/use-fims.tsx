import { useQuery } from '@tanstack/react-query'
import { useSetting } from '@workspace/db-react/use-setting'
import { env } from '@workspace/env/env'
import type {
  FimsDashboardMetric,
  FimsHistoricPoint,
  FimsPricePoint,
  FimsToken,
  FimsTransaction,
  FimsUser,
  FimsUserHistoricPoint,
} from '../fims-api.ts'
import { fimsGet } from '../fims-api.ts'

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

export function useFimsMember(address: string) {
  const users = useFimsUsers({ address })
  return { ...users, member: users.data?.[0] ?? null }
}

export function useFimsTransactions(params?: { userId?: number }) {
  const apiEndpoint = useFimsEndpoint()
  return useQuery({
    queryFn: () =>
      fimsGet<FimsTransaction[]>(apiEndpoint, '/transactions', {
        ...(params?.userId ? { userId: String(params.userId) } : {}),
      }),
    queryKey: ['fims', 'transactions', params?.userId],
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

export function useFimsUserHistoric(userId: number | undefined) {
  const apiEndpoint = useFimsEndpoint()
  return useQuery({
    enabled: userId != null,
    queryFn: () => fimsGet<FimsUserHistoricPoint[]>(apiEndpoint, '/user-historic', { userId: String(userId) }),
    queryKey: ['fims', 'user-historic', userId],
  })
}

export function useFimsPrices(token?: string) {
  const apiEndpoint = useFimsEndpoint()
  return useQuery({
    queryFn: () => fimsGet<FimsPricePoint[]>(apiEndpoint, '/prices', token ? { token } : {}),
    queryKey: ['fims', 'prices', token],
  })
}
