import type { DbContext } from '../db-context.ts'
import { populateNetworks } from '../populate-networks.ts'
import type { Network } from './network.ts'

// Public cluster endpoints the app used to seed. Solana's public RPC answers
// 403 to any request carrying a browser Origin, so a device seeded with one
// can never read mainnet — and seeded rows are written once, at install.
const PUBLIC_ENDPOINTS = new Set([
  'https://api.devnet.solana.com',
  'https://api.mainnet-beta.solana.com',
  'https://api.testnet.solana.com',
])

// Re-point seeded networks still on a public endpoint to the configured one.
// A row the user edited (any non-public endpoint) is never touched.
export async function networkSyncSeededEndpoints(
  ctx: DbContext,
  seeds: Network[] = populateNetworks(),
): Promise<number> {
  let updated = 0
  for (const seed of seeds) {
    if (PUBLIC_ENDPOINTS.has(seed.endpoint)) continue
    const row = await ctx.db.networks.get(seed.id)
    if (!row || !PUBLIC_ENDPOINTS.has(row.endpoint)) continue
    await ctx.db.networks.update(seed.id, {
      endpoint: seed.endpoint,
      endpointSubscriptions: seed.endpointSubscriptions ?? '',
      updatedAt: new Date(),
    })
    updated++
  }
  return updated
}
