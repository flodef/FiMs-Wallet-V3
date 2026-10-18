import { address } from '@solana/kit'
import type { Account } from '@workspace/db/account/account'
import type { Wallet } from '@workspace/db/wallet/wallet'
import { describe, expect, it } from 'vitest'

import { findExternalWalletRow } from '../src/data-access/find-external-wallet-row.ts'

function wallet(input: Partial<Wallet>): Wallet {
  return {
    derivationPath: 'd',
    id: 'w1',
    name: 'wallet',
    ...input,
  } as Wallet
}

function account(input: Partial<Account>): Account {
  return {
    id: 'a1',
    name: 'account',
    publicKey: address('So11111111111111111111111111111111111111112'),
    type: 'Derived',
    walletId: 'w1',
    ...input,
  } as Account
}

describe('find-external-wallet-row', () => {
  describe('expected behavior', () => {
    it('should match a wallet by its stamped externalWallet marker', () => {
      // ARRANGE
      expect.assertions(1)
      const solflare = wallet({ externalWallet: 'Solflare', id: 'ext-1' })
      const other = wallet({ id: 'w2' })

      // ACT
      const result = findExternalWalletRow([other, solflare], [], 'Solflare')

      // ASSERT
      expect(result?.id).toBe('ext-1')
    })

    it('should heal-match a legacy row by empty path + name when every account is secret-free', () => {
      // ARRANGE
      expect.assertions(1)
      const legacy = wallet({ derivationPath: '', id: 'legacy', name: 'Solflare' })
      const rows = [legacy]
      const accounts = [account({ type: 'Connected', walletId: 'legacy' })]

      // ACT
      const result = findExternalWalletRow(rows, accounts, 'Solflare')

      // ASSERT
      expect(result?.id).toBe('legacy')
    })

    it('should not heal-match a wallet holding an imported-key account', () => {
      // ARRANGE — a private-key import shares the empty derivationPath; a
      // same-named wallet must NOT be re-stamped external.
      expect.assertions(1)
      const imported = wallet({ derivationPath: '', id: 'imp', name: 'Solflare' })
      const accounts = [account({ type: 'Imported', walletId: 'imp' })]

      // ACT
      const result = findExternalWalletRow([imported], accounts, 'Solflare')

      // ASSERT
      expect(result).toBeUndefined()
    })
  })
})
