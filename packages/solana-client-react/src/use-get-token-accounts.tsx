import type { Address } from '@solana/kit'
import { queryOptions, useQuery } from '@tanstack/react-query'
import type { Network } from '@workspace/db/network/network'
import { getTokenAccountsDetailed } from '@workspace/solana-client/get-token-accounts'
import type { SolanaClient } from '@workspace/solana-client/solana-client'

import { useSolanaClient } from './use-solana-client.tsx'

export function getTokenAccountsQueryOptions({
  address,
  client,
  network,
}: {
  address: Address
  client: SolanaClient
  network: Network
}) {
  return queryOptions({
    queryFn: () => getTokenAccountsDetailed(client, { address }),
    queryKey: ['getTokenAccounts', network.endpoint, address],
  })
}

// `data` stays the plain account list for every consumer; `isPartial` flags
// that one token program could not be read (incomplete balances).
export function useGetTokenAccounts({ address, network }: { address: Address; network: Network }) {
  const client = useSolanaClient({ network })
  const query = useQuery(getTokenAccountsQueryOptions({ address, client, network }))
  return { ...query, data: query.data?.accounts, isPartial: !!query.data?.failedPrograms.length }
}
