import type { Address, Signature } from '@solana/kit'
import { infiniteQueryOptions, useInfiniteQuery } from '@tanstack/react-query'
import type { Network } from '@workspace/db/network/network'
import { type GetActivityItems, getActivity } from '@workspace/solana-client/get-activity'
import type { SolanaClient } from '@workspace/solana-client/solana-client'
import { useSolanaClient } from './use-solana-client.tsx'

export const ACTIVITY_PAGE_SIZE = 50

export function getActivityQueryOptions({
  address,
  network,
  client,
}: {
  address: Address
  network: Network
  client: SolanaClient
}) {
  return infiniteQueryOptions({
    getNextPageParam: (lastPage: GetActivityItems) =>
      lastPage.length === ACTIVITY_PAGE_SIZE ? lastPage.at(-1)?.signature : undefined,
    initialPageParam: undefined as Signature | undefined,
    queryFn: ({ pageParam }) => getActivity(client, { address, before: pageParam }),
    queryKey: ['getActivity', network.endpoint, address],
    // Signatures are immutable once confirmed — only the head changes.
    staleTime: 30 * 1000,
  })
}

export function useGetActivity({ address, network }: { address: Address; network: Network }) {
  const client = useSolanaClient({ network })

  return useInfiniteQuery(getActivityQueryOptions({ address, client, network }))
}
