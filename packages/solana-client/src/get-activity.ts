import type { Address, Commitment, Signature, Slot, TransactionError, UnixTimestamp } from '@solana/kit'

import type { SolanaClient } from './solana-client.ts'

export interface GetActivityOptions {
  address: Address
  // Pagination cursor: return signatures older than `before` (the last
  // signature of the previous page).
  before?: Signature | undefined
  limit?: number | undefined
}

export type GetActivityItem = Readonly<{
  blockTime: null | UnixTimestamp
  confirmationStatus: Commitment | null
  err: null | TransactionError
  memo: null | string
  signature: Signature
  slot: Slot
}>

export type GetActivityItems = Readonly<GetActivityItem[]>

export function getActivity(
  client: SolanaClient,
  { address, before, limit = 50 }: GetActivityOptions,
): Promise<GetActivityItems> {
  return client.rpc.getSignaturesForAddress(address, { ...(before ? { before } : {}), limit }).send()
}
