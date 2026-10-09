import type {
  SolanaSignAndSendTransactionInput,
  SolanaSignAndSendTransactionOutput,
} from '@solana/wallet-standard-features'

import { requireGranted } from '../services/permissions.ts'
import { getRequestService } from '../services/request.ts'

export async function signAndSendTransaction(
  inputs: SolanaSignAndSendTransactionInput[],
  origin: string,
): Promise<SolanaSignAndSendTransactionOutput[]> {
  for (const input of inputs) {
    await requireGranted(origin, input.account.address)
  }
  return await getRequestService().create('signAndSendTransaction', inputs, origin)
}
