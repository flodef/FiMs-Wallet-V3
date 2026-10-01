import { address, getAddressEncoder, getBase58Decoder, getProgramDerivedAddress } from '@solana/kit'
import { useQuery } from '@tanstack/react-query'
import { env } from '@workspace/env/env'
import { createSolanaClient } from '@workspace/solana-client/create-solana-client'
import { useMemo } from 'react'

const SNS_API = 'https://api.sns.id'

// SPL Name Service (SNS v1) — .sol name records live on mainnet.
const SNS_NAME_PROGRAM = address('namesLPneVptA9Z5rqUDD9tMTWEJwofgaYwp8cawRkX')
const SNS_HASH_PREFIX = 'SPL Name Service'
const SNS_SOL_TLD_PARENT = address('58PwtjSDuFHuUkYjH9BYnnQKHfwo9reZhC2zMJv9JPkx')

// Forward-resolves a .sol domain to its owner's address by deriving the name
// account PDA on-chain and reading the owner field — no third-party API.
export function useSnsResolveDomain(domain: string | undefined) {
  const client = useMemo(
    () => createSolanaClient({ url: env('networkMainnet') || 'https://api.mainnet-beta.solana.com' }),
    [],
  )
  return useQuery({
    enabled: !!domain,
    queryFn: async (): Promise<null | string> => {
      const name = domain?.replace(/\.sol$/, '') ?? ''
      const hashed = new Uint8Array(
        await crypto.subtle.digest('SHA-256', new TextEncoder().encode(SNS_HASH_PREFIX + name)),
      )
      const [nameAccount] = await getProgramDerivedAddress({
        programAddress: SNS_NAME_PROGRAM,
        seeds: [hashed, new Uint8Array(32), getAddressEncoder().encode(SNS_SOL_TLD_PARENT)],
      })
      const res = await client.rpc.getAccountInfo(nameAccount, { encoding: 'base64' }).send()
      if (!res.value?.data?.[0]) return null
      const bytes = Uint8Array.from(atob(res.value.data[0] as string), (c) => c.charCodeAt(0))
      // Name record header: parentName(32) + owner(32) + class(32)
      return getBase58Decoder().decode(bytes.slice(32, 64))
    },
    queryKey: ['sns-resolve', domain],
    retry: 1,
    staleTime: 5 * 60_000,
  })
}

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
