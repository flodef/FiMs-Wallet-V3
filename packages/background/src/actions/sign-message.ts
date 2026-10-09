import type { SolanaSignMessageInput, SolanaSignMessageOutput } from '@solana/wallet-standard-features'

import { requireGranted } from '../services/permissions.ts'
import { getRequestService } from '../services/request.ts'
import { assertMessageSignable } from '../services/sign-guards.ts'
import { decodeTransportBytes } from '../transport-bytes.ts'

export async function signMessage(
  inputs: SolanaSignMessageInput[],
  origin: string,
): Promise<SolanaSignMessageOutput[]> {
  for (const input of inputs) {
    await requireGranted(origin, input.account.address)
    assertMessageSignable(decodeTransportBytes(input.message))
  }
  return await getRequestService().create('signMessage', inputs, origin)
}
