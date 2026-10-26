import type { Account } from '@workspace/db/account/account'
import { type ComponentType, createContext, type ReactNode, useContext } from 'react'

// Protocol-ledger overlay for the chain P&L, injected by the shell like
// PortfolioPricingContext: feature-fims — which depends on this package —
// supplies the member's `transactions` rows so FiMs/FLiP/FiMsSOL get an
// exact EUR cost basis that on-chain flow analysis cannot reconstruct
// (mint/redeem are plain transfers, not swaps).
export interface PortfolioLedgerRow {
  amount: null | string
  donationAmount?: null | string
  movement: number
  token: null | string
  type: null | string
}

export interface PortfolioLedgerData {
  // symbol → mint for protocol tokens (lets rows join the chain flows).
  mintBySymbol: ReadonlyMap<string, string>
  rows: PortfolioLedgerRow[]
}

export interface PortfolioLedgerSourceProps {
  address: string
  children: (data: PortfolioLedgerData) => ReactNode
  // Reader consent: until granted, the source must not fire a signed
  // request that reveals "signer X reads target Y".
  enabled: boolean
  signer?: Account | undefined
}

// The injected value is a COMPONENT, not a hook: React Compiler memoizes
// calls of functions not named like hooks, so a hook handed through context
// and invoked as `ctx()(…)` got skipped on re-render (React error #300).
// A component owns its hooks; data flows back through the render prop.
export type PortfolioLedgerSource = ComponentType<PortfolioLedgerSourceProps>

const EMPTY_LEDGER: PortfolioLedgerData = { mintBySymbol: new Map(), rows: [] }

function DefaultLedgerSource({ children }: PortfolioLedgerSourceProps) {
  return <>{children(EMPTY_LEDGER)}</>
}

export const PortfolioLedgerContext = createContext<PortfolioLedgerSource>(DefaultLedgerSource)

export function PortfolioLedger(props: PortfolioLedgerSourceProps) {
  const Source = useContext(PortfolioLedgerContext)
  return <Source {...props} />
}
