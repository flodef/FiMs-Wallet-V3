import type { SolanaSignTransactionInput, SolanaSignTransactionOutput } from '@solana/wallet-standard-features'

import { requireGranted } from '../services/permissions.ts'
import { getRequestService } from '../services/request.ts'

export async function signTransaction(
  inputs: SolanaSignTransactionInput[],
  origin: string,
): Promise<SolanaSignTransactionOutput[]> {
  for (const input of inputs) {
    await requireGranted(origin, input.account.address)
  }
  return await getRequestService().create('signTransaction', inputs, origin)
}
