import type { StandardConnectInput, StandardConnectOutput } from '@wallet-standard/core'

import { grantOrigin } from '../services/permissions.ts'
import { getRequestService } from '../services/request.ts'

export async function connect(input: StandardConnectInput | undefined, origin: string): Promise<StandardConnectOutput> {
  const output = await getRequestService().create('connect', input, origin)
  const address = output.accounts[0]?.address
  if (address) {
    await grantOrigin(origin, address)
  }
  return output
}
