import type { Account } from '@workspace/db/account/account'
import { createContext, useContext } from 'react'

// Protocol-ledger overlay for the chain P&L, injected by the shell like
// PortfolioPricingContext: feature-fims — which depends on this package —
// supplies the member's `transactions` rows so FiMs/FLiP/FiMsSOL get an
// exact EUR cost basis that on-chain flow analysis cannot reconstruct
// (mint/redeem are plain transfers, not swaps).
export interface PortfolioLedgerRow {
  amount: null | string
  movement: number
  token: null | string
  type: null | string
}

export interface PortfolioLedgerData {
  // symbol → mint for protocol tokens (lets rows join the chain flows).
  mintBySymbol: ReadonlyMap<string, string>
  rows: PortfolioLedgerRow[]
}

export type UsePortfolioLedgerData = (address: string, signer?: Account) => PortfolioLedgerData

const defaultLedgerData: UsePortfolioLedgerData = () => ({ mintBySymbol: new Map(), rows: [] })

export const PortfolioLedgerContext = createContext<UsePortfolioLedgerData>(defaultLedgerData)

// Returns the injected hook — always call it unconditionally in the consumer.
export function usePortfolioLedger(): UsePortfolioLedgerData {
  return useContext(PortfolioLedgerContext)
}
