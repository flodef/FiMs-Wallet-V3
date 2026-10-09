import type { SolanaSignInInput, SolanaSignInOutput } from '@solana/wallet-standard-features'

import { grantedAddress, requireGranted } from '../services/permissions.ts'
import { getRequestService } from '../services/request.ts'

export async function signIn(inputs: SolanaSignInInput[], origin: string): Promise<SolanaSignInOutput[]> {
  const granted = await grantedAddress(origin)
  if (!granted) {
    throw new Error(`origin is not connected: ${origin}`)
  }
  // A dApp-supplied domain must match where the request actually came from —
  // otherwise a phishing page could mint SIWS messages for wallet-v3.fims.fi.
  const host = new URL(origin).host
  for (const input of inputs) {
    await requireGranted(origin, input.address || granted)
    if (input.domain && input.domain !== host) {
      throw new Error(`sign-in domain ${input.domain} does not match origin ${origin}`)
    }
  }
  return await getRequestService().create('signIn', inputs, origin)
}
