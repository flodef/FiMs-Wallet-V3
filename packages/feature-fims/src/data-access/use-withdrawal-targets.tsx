import type { Address } from '@solana/kit'
import { useSetting } from '@workspace/db-react/use-setting'
import { useMemo } from 'react'
import {
  FIMS_JUPITER_SPEND_SYMBOLS,
  FIMS_KNOWN_MINTS,
  FIMS_WITHDRAWAL_PROVIDERS,
  type FimsExchangeProvider,
} from '../fims-constants.ts'

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
  return useMemo(() => {
    const targets: WithdrawalTarget[] = []
    const exchangeProvider: FimsExchangeProvider = provider === 'nexo' ? 'nexo' : 'coinbase'
    if (exchangeAddress) {
      const symbols = FIMS_WITHDRAWAL_PROVIDERS[exchangeProvider].acceptedSymbols
      targets.push({
        acceptedMints: symbols.map((symbol) => FIMS_KNOWN_MINTS[symbol] as Address),
        acceptedSymbols: [...symbols],
        address: exchangeAddress as Address,
        label: exchangeProvider === 'nexo' ? 'Nexo' : 'Coinbase',
      })
    }
    if (spendAddress) {
      targets.push({
        acceptedMints: FIMS_JUPITER_SPEND_SYMBOLS.map((symbol) => FIMS_KNOWN_MINTS[symbol] as Address),
        acceptedSymbols: [...FIMS_JUPITER_SPEND_SYMBOLS],
        address: spendAddress as Address,
        label: 'Jupiter Spend',
      })
    }
    return targets
  }, [provider, exchangeAddress, spendAddress])
}
