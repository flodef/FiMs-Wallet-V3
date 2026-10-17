// Per-address sync cursor for the on-chain history reader. `oldestCursor`
// resumes the backfill into older history; `complete` means the reader has
// reached the address's first transaction.
export interface ChainSyncState {
  address: string
  complete: boolean
  oldestCursor: null | string
}
