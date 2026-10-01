import { useQuery } from '@tanstack/react-query'

const SNS_API = 'https://api.sns.id'

// Resolves a wallet address to its .sol name. Tries the wallet's primary
// (favorite) domain first; if none is set, falls back to the first domain the
// wallet owns. Returns null when the address has no SNS name or the API is
// unreachable — callers must keep showing the raw address in that case.
export function useSnsDomain(address: string | undefined) {
  return useQuery({
    enabled: !!address,
    queryFn: async (): Promise<null | string> => {
      const fav = await fetchSnsJson<Record<string, string>>(`${SNS_API}/v2/user/fav-domains/${address}`)
      const primary = fav?.[address ?? '']
      if (primary) {
        return `${primary}.sol`
      }

      const owned = await fetchSnsJson<Record<string, string[]>>(`${SNS_API}/v2/user/domains/${address}`)
      const first = owned?.[address ?? '']?.[0]
      return first ? `${first}.sol` : null
    },
    queryKey: ['sns-domain', address],
    retry: 1,
    staleTime: 5 * 60_000,
  })
}

async function fetchSnsJson<T>(url: string): Promise<T | undefined> {
  try {
    const res = await fetch(url)
    if (!res.ok) return undefined
    return (await res.json()) as T
  } catch {
    return undefined
  }
}
