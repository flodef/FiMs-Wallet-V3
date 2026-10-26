import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { Network } from '../src/network/network.ts'
import { networkSyncSeededEndpoints } from '../src/network/network-sync-seeded-endpoints.ts'
import { createDbContextTest } from './test-helpers.ts'

const ctx = createDbContextTest()

function network(input: Partial<Network>): Network {
  const now = new Date()
  return {
    createdAt: now,
    endpoint: 'https://api.mainnet-beta.solana.com',
    endpointSubscriptions: 'wss://api.mainnet-beta.solana.com',
    id: 'networkMainnet',
    name: 'Mainnet',
    type: 'solana:mainnet',
    updatedAt: now,
    ...input,
  }
}

const configured = network({
  endpoint: 'https://rpc.example.com/',
  endpointSubscriptions: 'wss://rpc.example.com/',
})

describe('network-sync-seeded-endpoints', () => {
  beforeEach(async () => {
    await ctx.db.networks.clear()
  })

  describe('expected behavior', () => {
    it('should re-point a seeded network still on the public endpoint', async () => {
      // ARRANGE
      expect.assertions(3)
      await ctx.db.networks.add(network({}))

      // ACT
      const result = await networkSyncSeededEndpoints(ctx, [configured])

      // ASSERT
      const row = await ctx.db.networks.get('networkMainnet')
      expect(result).toBe(1)
      expect(row?.endpoint).toBe('https://rpc.example.com/')
      expect(row?.endpointSubscriptions).toBe('wss://rpc.example.com/')
    })

    it('should never overwrite an endpoint the user customized', async () => {
      // ARRANGE
      expect.assertions(2)
      await ctx.db.networks.add(network({ endpoint: 'https://my-own-rpc.example.org/' }))

      // ACT
      const result = await networkSyncSeededEndpoints(ctx, [configured])

      // ASSERT
      const row = await ctx.db.networks.get('networkMainnet')
      expect(result).toBe(0)
      expect(row?.endpoint).toBe('https://my-own-rpc.example.org/')
    })

    it('should do nothing while the configured endpoint is itself public', async () => {
      // ARRANGE
      expect.assertions(1)
      await ctx.db.networks.add(network({}))

      // ACT
      const result = await networkSyncSeededEndpoints(ctx, [network({})])

      // ASSERT
      expect(result).toBe(0)
    })
  })

  describe('unexpected behavior', () => {
    beforeEach(() => {
      vi.spyOn(console, 'log').mockImplementation(() => {})
    })

    afterEach(() => {
      vi.restoreAllMocks()
    })

    it('should skip a seed whose network row does not exist', async () => {
      // ARRANGE
      expect.assertions(2)

      // ACT
      const result = await networkSyncSeededEndpoints(ctx, [configured])

      // ASSERT
      expect(result).toBe(0)
      expect(await ctx.db.networks.count()).toBe(0)
    })
  })
})
