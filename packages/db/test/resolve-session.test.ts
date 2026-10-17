import { address } from '@solana/kit'
import { describe, expect, it } from 'vitest'
import type { Account } from '../src/account/account.ts'
import type { Network } from '../src/network/network.ts'
import {
  hasAdminAccount,
  orderedAccounts,
  resolveActiveAccount,
  resolveAllowedNetwork,
} from '../src/session/resolve-session.ts'
import type { Wallet } from '../src/wallet/wallet.ts'

const account = (input: Partial<Account>): Account =>
  ({
    id: input.id ?? 'a',
    name: 'a',
    order: input.order ?? 0,
    publicKey: input.publicKey ?? address('So11111111111111111111111111111111111111112'),
    type: input.type ?? 'Derived',
    walletId: input.walletId ?? 'w',
  }) as Account

const wallet = (input: Partial<Wallet>): Pick<Wallet, 'id' | 'order'> => ({
  id: input.id ?? 'w',
  order: input.order ?? 0,
})

const network = (id: string, type: Network['type']): Network => ({ id, name: id, type }) as Network

describe('resolve-session', () => {
  describe('resolveActiveAccount', () => {
    it('should keep the active account when it exists', () => {
      // ARRANGE
      expect.assertions(2)
      const accounts = [account({ id: 'a' }), account({ id: 'b' })]

      // ACT
      const result = resolveActiveAccount({ accounts, activeAccountId: 'b', wallets: [wallet({})] })

      // ASSERT
      expect(result.account?.id).toBe('b')
      expect(result.repaired).toBe(false)
    })

    it('should repair a dangling active id to the first visible account', () => {
      // ARRANGE
      expect.assertions(2)
      const accounts = [account({ id: 'a', order: 1, walletId: 'w2' }), account({ id: 'b', order: 0, walletId: 'w1' })]

      // ACT
      const result = resolveActiveAccount({
        accounts,
        activeAccountId: 'deleted',
        wallets: [wallet({ id: 'w1', order: 0 }), wallet({ id: 'w2', order: 1 })],
      })

      // ASSERT
      expect(result.account?.id).toBe('b')
      expect(result.repaired).toBe(true)
    })

    it('should return null when no account exists', () => {
      // ARRANGE
      expect.assertions(2)

      // ACT
      const result = resolveActiveAccount({ accounts: [], activeAccountId: null, wallets: [] })

      // ASSERT
      expect(result.account).toBeNull()
      expect(result.repaired).toBe(false)
    })
  })

  describe('hasAdminAccount', () => {
    it('should grant admin to a signing account with an admin address', () => {
      // ARRANGE
      expect.assertions(1)

      // ACT
      const adminPk = address('So11111111111111111111111111111111111111112')
      const result = hasAdminAccount([account({ publicKey: adminPk, type: 'Connected' })], [adminPk])

      // ASSERT
      expect(result).toBe(true)
    })

    it('should not grant admin to a watched account with an admin address', () => {
      // ARRANGE
      expect.assertions(1)

      // ACT
      const adminPk = address('So11111111111111111111111111111111111111112')
      const result = hasAdminAccount([account({ publicKey: adminPk, type: 'Watched' })], [adminPk])

      // ASSERT
      expect(result).toBe(false)
    })
  })

  describe('resolveAllowedNetwork', () => {
    const networks = [network('m', 'solana:mainnet'), network('d', 'solana:devnet'), network('l', 'solana:localnet')]

    it('should force a non-admin on devnet back to mainnet', () => {
      // ARRANGE
      expect.assertions(2)

      // ACT
      const result = resolveAllowedNetwork({ activeNetworkId: 'd', demo: false, isAdmin: false, networks })

      // ASSERT
      expect(result.network?.type).toBe('solana:mainnet')
      expect(result.repaired).toBe(true)
    })

    it('should keep an admin on devnet', () => {
      // ARRANGE
      expect.assertions(2)

      // ACT
      const result = resolveAllowedNetwork({ activeNetworkId: 'd', demo: false, isAdmin: true, networks })

      // ASSERT
      expect(result.network?.type).toBe('solana:devnet')
      expect(result.repaired).toBe(false)
    })

    it('should keep a non-admin on localnet', () => {
      // ARRANGE
      expect.assertions(1)

      // ACT
      const result = resolveAllowedNetwork({ activeNetworkId: 'l', demo: false, isAdmin: false, networks })

      // ASSERT
      expect(result.network?.type).toBe('solana:localnet')
    })

    it('should keep devnet during the demo', () => {
      // ARRANGE
      expect.assertions(1)

      // ACT
      const result = resolveAllowedNetwork({ activeNetworkId: 'd', demo: true, isAdmin: false, networks })

      // ASSERT
      expect(result.network?.type).toBe('solana:devnet')
    })

    it('should repair a missing or dangling network to mainnet', () => {
      // ARRANGE
      expect.assertions(4)

      // ACT
      const missing = resolveAllowedNetwork({ activeNetworkId: null, demo: false, isAdmin: false, networks })
      const dangling = resolveAllowedNetwork({ activeNetworkId: 'gone', demo: false, isAdmin: false, networks })

      // ASSERT
      expect(missing.network?.type).toBe('solana:mainnet')
      expect(missing.repaired).toBe(true)
      expect(dangling.network?.type).toBe('solana:mainnet')
      expect(dangling.repaired).toBe(true)
    })
  })

  describe('orderedAccounts', () => {
    it('should sort by wallet order then account order', () => {
      // ARRANGE
      expect.assertions(1)
      const accounts = [
        account({ id: 'c', order: 0, walletId: 'w2' }),
        account({ id: 'a', order: 1, walletId: 'w1' }),
        account({ id: 'b', order: 0, walletId: 'w1' }),
      ]

      // ACT
      const result = orderedAccounts(accounts, [wallet({ id: 'w1', order: 0 }), wallet({ id: 'w2', order: 1 })])

      // ASSERT
      expect(result.map((a) => a.id)).toEqual(['b', 'a', 'c'])
    })
  })
})
