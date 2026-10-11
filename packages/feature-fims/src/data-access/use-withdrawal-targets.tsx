import type { Address } from '@solana/kit'
import { useSetting } from '@workspace/db-react/use-setting'
import { useMemo } from 'react'
import {
  FIMS_JUPITER_SPEND_SYMBOLS,
  FIMS_KNOWN_MINTS,
  FIMS_WITHDRAWAL_PROVIDERS,
  type FimsExchangeProvider,
  fimsWithdrawalAcceptedSymbols,
} from '../fims-constants.ts'
import { parseWithdrawalDestinations } from './use-withdrawal-destinations.tsx'

export interface WithdrawalTarget {
  // Mint the destination accepts, in preference order — the first entry is
  // what an unsupported outgoing token gets converted into.
  acceptedMints: Address[]
  acceptedSymbols: string[]
  address: Address
  label: string
}

export function useWithdrawalTargets(): WithdrawalTarget[] {
  const [provider] = useSetting('withdrawExchangeProvider')
  const [exchangeAddress] = useSetting('withdrawExchangeAddress')
  const [spendAddress] = useSetting('withdrawJupiterSpend')
  const [destinationsRaw] = useSetting('withdrawalDestinations')
  return useMemo(() => {
    const targets: WithdrawalTarget[] = []
    const seen = new Set<string>()
    // Saved destination list (new model) — each entry carries its own
    // provider, so Coinbase, Nexo, Jupiter Spend and custom addresses can
    // coexist.
    for (const destination of parseWithdrawalDestinations(destinationsRaw)) {
      const symbols = fimsWithdrawalAcceptedSymbols(destination.provider)
      targets.push({
        acceptedMints: symbols.map((symbol) => FIMS_KNOWN_MINTS[symbol] as Address),
        acceptedSymbols: [...symbols],
        address: destination.address as Address,
        label: destination.name,
      })
      seen.add(destination.address)
    }
    // Legacy single-address settings — still honored until the settings page
    // migrates them into the list.
    const exchangeProvider: FimsExchangeProvider = provider === 'nexo' ? 'nexo' : 'coinbase'
    if (exchangeAddress && !seen.has(exchangeAddress)) {
      const symbols = FIMS_WITHDRAWAL_PROVIDERS[exchangeProvider].acceptedSymbols
      targets.push({
        acceptedMints: symbols.map((symbol) => FIMS_KNOWN_MINTS[symbol] as Address),
        acceptedSymbols: [...symbols],
        address: exchangeAddress as Address,
        label: exchangeProvider === 'nexo' ? 'Nexo' : 'Coinbase',
      })
      seen.add(exchangeAddress)
    }
    if (spendAddress && !seen.has(spendAddress)) {
      targets.push({
        acceptedMints: FIMS_JUPITER_SPEND_SYMBOLS.map((symbol) => FIMS_KNOWN_MINTS[symbol] as Address),
        acceptedSymbols: [...FIMS_JUPITER_SPEND_SYMBOLS],
        address: spendAddress as Address,
        label: 'Jupiter Spend',
      })
    }
    return targets
  }, [provider, exchangeAddress, spendAddress, destinationsRaw])
}
