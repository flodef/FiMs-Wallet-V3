// Cached normalized on-chain transaction (mirror of the API's
// /fims/chain/history row). Stored per signature so the tx reader only syncs
// the delta instead of re-fetching the full history each visit.
export interface ChainTransfer {
  amount: number
  counterparty: null | string
  counterpartyLabel: null | string
  direction: 'in' | 'out'
  mint: null | string
  symbol: null | string
}

export interface ChainTransaction {
  description: string
  feeSol: number
  signature: string
  source: null | string
  timestamp: number
  transfers: ChainTransfer[]
  type: string
}

export interface ChainTransactionRecord extends ChainTransaction {
  // The wallet this history was fetched for — a tx can be cached under
  // several addresses, so the key is composite.
  address: string
}
