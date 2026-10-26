import type { Account } from '@workspace/db/account/account'
import type { Network } from '@workspace/db/network/network'
import { useChainHistory } from '@workspace/feature-portfolio/data-access/use-chain-reader'
import { useMemo } from 'react'
import type { FimsUser } from '../fims-api.ts'
import { computeFimsCostBasisEur } from '../fims-realized.ts'
import { useFimsTokens, useFimsTransactions } from './use-fims.tsx'
import { useFimsCurrency } from './use-fims-currency.tsx'

// Realized-gain cost basis (PRU) per mint for the member's wallet: the exact
// EUR basis from the FiMs ledger for protocol tokens, reconstructed from
// on-chain swap legs for everything else. Drives the tontine carve — while
// the basis is unknowable a member's outgoing operation stays pending
// rather than carving on a guess.
export function useFimsRealized(member: FimsUser | null, account: Account, network: Network) {
  const transactions = useFimsTransactions(member ? { userId: member.id } : undefined, account, !!member)
  const tokens = useFimsTokens()
  const { rates } = useFimsCurrency()
  const onMainnet = network.type === 'solana:mainnet'
  // Members only — a non-member owes no carve, so no basis and no sync.
  // Watched accounts are skipped: they cannot send, and their signer would
  // be a different account whose reads need the reader's explicit consent.
  const chainEnabled = !!member && onMainnet && account.type !== 'Watched'
  const history = useChainHistory({ account, address: account.publicKey, enabled: chainEnabled })

  const mintBySymbol = useMemo(
    () =>
      new Map(
        (tokens.data ?? []).flatMap((token) => (token.address ? ([[token.symbol, token.address]] as const) : [])),
      ),
    [tokens.data],
  )
  const basis = useMemo(
    () =>
      computeFimsCostBasisEur({
        chainTxs: history.data?.transactions ?? [],
        ledgerRows: transactions.data ?? [],
        mintBySymbol,
        usdPerEur: rates.usd,
      }),
    [history.data, transactions.data, mintBySymbol, rates.usd],
  )
  // Until the ledger rows AND the complete chain backfill are in, part of
  // the basis is unknowable — report pending so callers can hold the
  // operation instead of charging the member a worst-case gain.
  const isLoading =
    !!member && (transactions.isLoading || (chainEnabled && (history.isLoading || history.data?.complete === false)))
  return { basis, isLoading }
}
