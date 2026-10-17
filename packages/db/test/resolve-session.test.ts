import { address } from '@solana/kit'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Account } from '../src/account/account.ts'
import type { Network } from '../src/network/network.ts'
import {
  hasAdminAccount,
  orderedAccounts,
  resolveActiveAccount,
  resolveAllowedNetwork,
} from '../src/session/resolve-session.ts'

const ADMIN = address('So11111111111111111111111111111111111111112')

function account(input: Partial<Account> & { id: string; walletId: string }): Account {
  return {
    createdAt: new Date(),
    derivationIndex: 0,
    name: input.id,
    order: 0,
    publicKey: address('11111111111111111111111111111111'),
    type: 'Derived',
    updatedAt: new Date(),
    ...input,
  } as Account
}

function network(id: string, type: Network['type']): Network {
  return { createdAt: new Date(), endpoint: 'http://x', id, name: id, type, updatedAt: new Date() } as Network
}

const wallets = [
  { id: 'w2', order: 1 },
  { id: 'w1', order: 0 },
]
const networks = [
  network('main', 'solana:mainnet'),
  network('dev', 'solana:devnet'),
  network('local', 'solana:localnet'),
]

describe('resolve-session', () => {
  describe('expected behavior', () => {
    it('should order accounts by wallet order then account order', () => {
      // ARRANGE
      expect.assertions(1)
      const accounts = [
        account({ id: 'b', order: 0, walletId: 'w2' }),
        account({ id: 'a2', order: 1, walletId: 'w1' }),
        account({ id: 'a1', order: 0, walletId: 'w1' }),
      ]

      // ACT
      const result = orderedAccounts(accounts, wallets).map((item) => item.id)

      // ASSERT
      expect(result).toEqual(['a1', 'a2', 'b'])
    })

    it('should keep a valid active account', () => {
      // ARRANGE
      expect.assertions(2)
      const accounts = [account({ id: 'a1', walletId: 'w1' }), account({ id: 'b', walletId: 'w2' })]

      // ACT
      const result = resolveActiveAccount({ accounts, activeAccountId: 'b', wallets })

      // ASSERT
      expect(result.account?.id).toBe('b')
      expect(result.repaired).toBe(false)
    })

    it('should repair a dangling active account with the first visible one', () => {
      // ARRANGE
      expect.assertions(2)
      const accounts = [account({ id: 'b', walletId: 'w2' }), account({ id: 'a1', walletId: 'w1' })]

      // ACT
      const result = resolveActiveAccount({ accounts, activeAccountId: 'deleted', wallets })

      // ASSERT
      expect(result.account?.id).toBe('a1')
      expect(result.repaired).toBe(true)
    })

    it('should report no account when none exist', () => {
      // ARRANGE
      expect.assertions(2)

      // ACT
      const result = resolveActiveAccount({ accounts: [], activeAccountId: null, wallets })

      // ASSERT
      expect(result.account).toBeNull()
      expect(result.repaired).toBe(false)
    })

    it('should grant admin only to a signing account', () => {
      // ARRANGE
      expect.assertions(3)

      // ACT
      const result1 = hasAdminAccount([{ publicKey: ADMIN, type: 'Connected' }], [ADMIN])
      const result2 = hasAdminAccount([{ publicKey: ADMIN, type: 'Watched' }], [ADMIN])
      const result3 = hasAdminAccount([{ publicKey: ADMIN, type: 'Derived' }], [])

      // ASSERT
      expect(result1).toBe(true)
      expect(result2).toBe(false)
      expect(result3).toBe(false)
    })

    it('should force a non-admin from devnet back to mainnet', () => {
      // ARRANGE
      expect.assertions(2)

      // ACT
      const result = resolveAllowedNetwork({ activeNetworkId: 'dev', demo: false, isAdmin: false, networks })

      // ASSERT
      expect(result.network?.id).toBe('main')
      expect(result.repaired).toBe(true)
    })

    it('should keep devnet for admins and the demo, and localnet for everyone', () => {
      // ARRANGE
      expect.assertions(3)

      // ACT
      const result1 = resolveAllowedNetwork({ activeNetworkId: 'dev', demo: false, isAdmin: true, networks })
      const result2 = resolveAllowedNetwork({ activeNetworkId: 'dev', demo: true, isAdmin: false, networks })
      const result3 = resolveAllowedNetwork({ activeNetworkId: 'local', demo: false, isAdmin: false, networks })

      // ASSERT
      expect(result1.repaired).toBe(false)
      expect(result2.repaired).toBe(false)
      expect(result3.repaired).toBe(false)
    })
  })

  describe('unexpected behavior', () => {
    beforeEach(() => {
      vi.spyOn(console, 'log').mockImplementation(() => {})
    })

    afterEach(() => {
      vi.restoreAllMocks()
    })

    it('should repair a missing network id to mainnet', () => {
      // ARRANGE
      expect.assertions(2)

      // ACT
      const result = resolveAllowedNetwork({ activeNetworkId: 'gone', demo: false, isAdmin: true, networks })

      // ASSERT
      expect(result.network?.id).toBe('main')
      expect(result.repaired).toBe(true)
    })

    it('should not repair when no mainnet exists', () => {
      // ARRANGE
      expect.assertions(2)

      // ACT
      const result = resolveAllowedNetwork({
        activeNetworkId: 'dev',
        demo: false,
        isAdmin: false,
        networks: [network('dev', 'solana:devnet')],
      })

      // ASSERT
      expect(result.network?.id).toBe('dev')
      expect(result.repaired).toBe(false)
    })
  })
})
