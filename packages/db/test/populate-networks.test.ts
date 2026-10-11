import { setEnv } from '@workspace/env/env'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { populateNetworks } from '../src/populate-networks.ts'

describe('populate-networks', () => {
  describe('expected behavior', () => {
    it('should create networks from configured endpoints', () => {
      // ARRANGE
      expect.assertions(2)

      // ACT
      const result = populateNetworks()

      // ASSERT
      expect(
        result.map((network) => ({
          endpoint: network.endpoint,
          endpointSubscriptions: network.endpointSubscriptions,
          id: network.id,
          name: network.name,
          type: network.type,
        })),
      ).toEqual([
        {
          endpoint: 'https://api.devnet.solana.com',
          endpointSubscriptions: '',
          id: 'networkDevnet',
          name: 'Devnet',
          type: 'solana:devnet',
        },
        {
          endpoint: 'http://localhost:8899',
          endpointSubscriptions: 'ws://127.0.0.1:8900',
          id: 'networkLocalnet',
          name: 'Localnet',
          type: 'solana:localnet',
        },
        {
          endpoint: 'https://api.mainnet-beta.solana.com',
          endpointSubscriptions: 'wss://api.mainnet-beta.solana.com',
          id: 'networkMainnet',
          name: 'Mainnet',
          type: 'solana:mainnet',
        },
        {
          endpoint: 'https://api.testnet.solana.com',
          endpointSubscriptions: '',
          id: 'networkTestnet',
          name: 'Testnet',
          type: 'solana:testnet',
        },
      ])
      expect(result.every((network) => network.createdAt instanceof Date && network.updatedAt instanceof Date)).toBe(
        true,
      )
    })
  })

  describe('unexpected behavior', () => {
    beforeEach(() => {
      vi.spyOn(console, 'log').mockImplementation(() => {})
    })

    afterEach(() => {
      vi.restoreAllMocks()
      setEnv()
    })

    it('should not include networks without configured endpoints', () => {
      // ARRANGE
      expect.assertions(1)
      // Blanking an endpoint removes that network from the populated set.
      setEnv({ networkTestnet: '' })

      // ACT
      const result = populateNetworks()

      // ASSERT
      expect(result.map((network) => network.id)).not.toContain('networkTestnet')
    })
  })
})
