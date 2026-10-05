import type { ChainTransaction } from './chain-api.ts'

// Coarse wallet-facing classification of a normalized chain tx. The Helius
// `type` stays available for display; this layer answers "what does this mean
// for the watched wallet".
export type ChainTxKind = 'deposit' | 'donation' | 'other' | 'swap' | 'transfer' | 'withdrawal'

export function classifyChainTx(tx: ChainTransaction): ChainTxKind {
  // A transfer out whose counterparty is the tontine wallet is a donation —
  // the server resolves that address to the "Tontine" label.
  if (tx.transfers.some((t) => t.direction === 'out' && t.counterpartyLabel === 'Tontine')) {
    return 'donation'
  }
  if (tx.type === 'SWAP') return 'swap'
  const hasIn = tx.transfers.some((t) => t.direction === 'in')
  const hasOut = tx.transfers.some((t) => t.direction === 'out')
  if (hasIn && !hasOut) return 'deposit'
  if (hasOut && !hasIn) return 'withdrawal'
  if (hasIn && hasOut) return 'transfer'
  return 'other'
}

// Counterparty shown next to the amount: the labeled peer when Helius resolved
// one, else the tx source (e.g. JUPITER) — the program is the only "peer" a
// swap has.
export function chainTxPeer(tx: ChainTransaction): null | string {
  const labeled = tx.transfers.find((t) => t.counterpartyLabel)
  if (labeled?.counterpartyLabel) return labeled.counterpartyLabel
  return tx.source
}

// Signed net amount per (mint, symbol) across the transfers touching the
// watched address — 'in' positive, 'out' negative.
export function chainTxNetAmounts(tx: ChainTransaction): { amount: number; symbol: string }[] {
  const bySymbol = new Map<string, number>()
  for (const t of tx.transfers) {
    const symbol = t.symbol ?? t.mint?.slice(0, 4) ?? 'SOL'
    bySymbol.set(symbol, (bySymbol.get(symbol) ?? 0) + (t.direction === 'in' ? t.amount : -t.amount))
  }
  return [...bySymbol.entries()].map(([symbol, amount]) => ({ amount, symbol }))
}
