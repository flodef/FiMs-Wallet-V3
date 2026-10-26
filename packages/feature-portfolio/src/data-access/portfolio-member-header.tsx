import { type ComponentType, createContext, useContext } from 'react'

// Protocol member summary (FiMs invested/value/P&L) injected by the shell —
// same component-via-context pattern as PortfolioLedgerContext: the injected
// value owns its hooks, so React Compiler memoization stays safe.
export interface PortfolioMemberHeaderProps {
  address: string
}

export type PortfolioMemberHeaderSource = ComponentType<PortfolioMemberHeaderProps>

const DefaultMemberHeader: PortfolioMemberHeaderSource = () => null

export const PortfolioMemberHeaderContext = createContext<PortfolioMemberHeaderSource>(DefaultMemberHeader)

export function PortfolioMemberHeader(props: PortfolioMemberHeaderProps) {
  const Source = useContext(PortfolioMemberHeaderContext)
  return <Source {...props} />
}
