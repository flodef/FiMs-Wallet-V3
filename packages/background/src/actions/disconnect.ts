import { revokeOrigin } from '../services/permissions.ts'

export async function disconnect(origin: string): Promise<void> {
  await revokeOrigin(origin)
}
