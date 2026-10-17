import { address } from '@solana/kit'
import type { GetTokenAccountsResult } from '@workspace/solana-client/get-token-accounts'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type PortfolioPricing, tokenValueEur } from '../src/data-access/portfolio-pricing.tsx'
import { mergeTokenBalances } from '../src/data-access/use-get-token-balances.ts'

const owner = address('So11111111111111111111111111111111111111113')
const fimsMint = address('So11111111111111111111111111111111111111114')
const jupMint = address('So11111111111111111111111111111111111111115')
const unknownMint = address('So11111111111111111111111111111111111111116')

function tokenAccount(mint: string, amount: string, decimals: number) {
  return {
    account: { data: { parsed: { info: { mint, tokenAmount: { amount, decimals } } } } },
    pubkey: address('So11111111111111111111111111111111111111117'),
  } as unknown as GetTokenAccountsResult[number]
}

const pricing: PortfolioPricing = {
  format: (eur) => `${eur.toFixed(2)} EUR`,
  metadata: new Map([[fimsMint, { decimals: 0, icon: '', id: fimsMint, name: 'FiMs', symbol: 'FIMS', usdPrice: 0 }]]),
  pricesEur: new Map([[fimsMint, 2]]),
  usdPerEur: 1.25,
}

describe('merge-token-balances', () => {
  describe('expected behavior', () => {
    it('should value FiMs tokens with the protocol EUR price and name them', () => {
      // ARRANGE
      expect.assertions(3)

      // ACT
      const result = mergeTokenBalances({
        account: owner,
        balance: 0n,
        metadata: [],
        pricing,
        tokenAccounts: [tokenAccount(fimsMint, '3000000', 6)],
      }).find((item) => item.mint === fimsMint)

      // ASSERT
      expect(result?.valueEur).toBe(6)
      expect(result?.balanceValue).toBe('6.00 EUR')
      expect(result?.metadata?.symbol).toBe('FIMS')
    })

    it('should convert Jupiter USD prices to EUR and sort priced tokens first', () => {
      // ARRANGE
      expect.assertions(2)

      // ACT
      const result = mergeTokenBalances({
        account: owner,
        balance: 0n,
        metadata: [{ decimals: 6, icon: '', id: jupMint, name: 'Jup', symbol: 'JUP', usdPrice: 5 }],
        pricing,
        tokenAccounts: [tokenAccount(unknownMint, '1000000', 6), tokenAccount(jupMint, '1000000', 6)],
      })

      // ASSERT
      expect(result.find((item) => item.mint === jupMint)?.valueEur).toBe(4)
      expect(result[0]?.mint).toBe(jupMint)
    })
  })

  describe('unexpected behavior', () => {
    beforeEach(() => {
      vi.spyOn(console, 'log').mockImplementation(() => {})
    })

    afterEach(() => {
      vi.restoreAllMocks()
    })

    it('should leave an unpriced token without a value', () => {
      // ARRANGE
      expect.assertions(2)

      // ACT
      const result = mergeTokenBalances({
        account: owner,
        balance: 0n,
        metadata: [],
        pricing,
        tokenAccounts: [tokenAccount(unknownMint, '1000000', 6)],
      }).find((item) => item.mint === unknownMint)

      // ASSERT
      expect(result?.valueEur).toBeNull()
      expect(result?.balanceValue).toBe('—')
    })

    it('should not value a USD price when the EUR rate is unknown', () => {
      // ARRANGE
      expect.assertions(1)

      // ACT
      const result = tokenValueEur(
        { balance: 1_000_000n, decimals: 6, mint: jupMint, usdPrice: 5 },
        { ...pricing, usdPerEur: 0 },
      )

      // ASSERT
      expect(result).toBeNull()
    })
  })
})
