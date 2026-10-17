import type { Address } from '@solana/kit'
import type { Network } from '@workspace/db/network/network'
import { formatBalance } from '@workspace/feature-explorer/data-access/format-balance'
import { NATIVE_MINT } from '@workspace/solana-client/constants'
import type { GetTokenAccountsResult } from '@workspace/solana-client/get-token-accounts'
import type { TokenMetadata } from '@workspace/solana-client/get-token-metadata-jupiter'
import { useGetBalance } from '@workspace/solana-client-react/use-get-balance'
import { useGetTokenAccounts } from '@workspace/solana-client-react/use-get-token-accounts'
import { useGetTokenMetadataJupiter } from '@workspace/solana-client-react/use-get-token-metadata-jupiter'
import { useMemo } from 'react'
import { type PortfolioPricing, tokenValueEur, usePortfolioPricing } from './portfolio-pricing.tsx'

export interface TokenBalance {
  account: Address
  balance: bigint
  balanceToken?: string
  // Formatted value in the user's display currency ('—' when unpriced).
  balanceValue?: string
  decimals: number
  metadata?: TokenMetadata | undefined
  mint: Address
  // Value in EUR, null when no price source knows the mint.
  valueEur: null | number
}

export interface TokenBalancesState {
  isError: boolean
  isLoading: boolean
  // One token program could not be read — balances are incomplete.
  isPartial: boolean
  items: TokenBalance[]
  refetch: () => void
}

// Full state (loading / error / partial) for screens that must tell the user
// why the list is empty or incomplete.
export function useGetTokenBalancesState({ address, network }: { address: Address; network: Network }) {
  const balanceQuery = useGetBalance({ address, network })
  const tokenAccountsQuery = useGetTokenAccounts({ address, network })
  const pricing = usePortfolioPricing()
  const tokenAccounts = tokenAccountsQuery.data

  const mints = useMemo(() => {
    return [NATIVE_MINT, ...(tokenAccounts ?? []).map((t) => t.account.data.parsed.info.mint)]
  }, [tokenAccounts])

  const metadata = useGetTokenMetadataJupiter(mints)
  const isLoading = balanceQuery.isLoading || tokenAccountsQuery.isLoading

  const items = useMemo(
    () =>
      isLoading
        ? []
        : mergeTokenBalances({
            account: address,
            balance: balanceQuery.data?.value ?? 0n,
            metadata: metadata.data ?? [],
            pricing,
            tokenAccounts: tokenAccounts ?? [],
          }),
    [address, balanceQuery.data, isLoading, metadata.data, pricing, tokenAccounts],
  )

  return {
    isError: balanceQuery.isError || tokenAccountsQuery.isError,
    isLoading,
    isPartial: tokenAccountsQuery.isPartial,
    items,
    refetch: () => {
      void balanceQuery.refetch()
      void tokenAccountsQuery.refetch()
    },
  } satisfies TokenBalancesState
}

export function useGetTokenBalances({ address, network }: { address: Address; network: Network }) {
  return useGetTokenBalancesState({ address, network }).items
}

export function mergeTokenBalances({
  account,
  balance,
  metadata,
  pricing,
  tokenAccounts,
}: {
  account: Address
  balance: bigint
  metadata: TokenMetadata[]
  pricing: PortfolioPricing
  tokenAccounts: GetTokenAccountsResult
}): TokenBalance[] {
  const build = (input: Omit<TokenBalance, 'balanceToken' | 'balanceValue' | 'valueEur'>): TokenBalance => {
    const valueEur = tokenValueEur({ ...input, usdPrice: input.metadata?.usdPrice }, pricing)
    return {
      ...input,
      balanceToken: formatBalance({ balance: input.balance, decimals: input.decimals }),
      balanceValue: valueEur === null ? '—' : pricing.format(valueEur),
      valueEur,
    }
  }
  const solMetadata = metadata.find((m) => m.id === NATIVE_MINT)
  const solBalance = build({
    account,
    balance,
    decimals: solMetadata?.decimals ?? 9,
    metadata: solMetadata,
    mint: NATIVE_MINT,
  })

  const tokenBalances = tokenAccounts.map((tokenAccount) => {
    const info = tokenAccount.account.data.parsed.info
    const mint = info.mint
    return build({
      account: tokenAccount.pubkey,
      balance: BigInt(info.tokenAmount.amount),
      decimals: info.tokenAmount.decimals,
      // FiMs-family mints are unknown to Jupiter: the protocol's own label
      // names them instead of an ellipsified mint.
      metadata: metadata.find((m) => m.id === mint) ?? pricing.metadata?.get(mint),
      mint,
    })
  })

  // Priced tokens first (by value), then the rest.
  return [solBalance, ...tokenBalances].sort((a, b) => {
    const priced = (b.valueEur !== null ? 1 : 0) - (a.valueEur !== null ? 1 : 0)
    return priced || (b.valueEur ?? 0) - (a.valueEur ?? 0)
  })
}
