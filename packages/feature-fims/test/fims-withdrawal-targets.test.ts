import { describe, expect, it } from 'vitest'
import {
  FIMS_JUPITER_SPEND_SYMBOLS,
  FIMS_KNOWN_MINTS,
  FIMS_MINT_DECIMALS,
  FIMS_WITHDRAWAL_PROVIDERS,
} from '../src/fims-constants.ts'

describe('fims withdrawal targets', () => {
  describe('expected behavior', () => {
    it('should pin the canonical mainnet mint for every accepted symbol', () => {
      // ARRANGE
      expect.assertions(5)
      const accepted = new Set([
        ...FIMS_JUPITER_SPEND_SYMBOLS,
        ...Object.values(FIMS_WITHDRAWAL_PROVIDERS).flatMap((provider) => [...provider.acceptedSymbols]),
      ])

      // ACT & ASSERT — a typo here sends swaps to a dead or fake mint.
      expect(FIMS_KNOWN_MINTS['USDC']).toBe('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v')
      expect(FIMS_KNOWN_MINTS['USDT']).toBe('Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB')
      expect(FIMS_KNOWN_MINTS['SOL']).toBe('So11111111111111111111111111111111111111112')
      expect(FIMS_KNOWN_MINTS['EURC']).toBe('HzwqbKZw8HxMN6bF2yFZNrht3c2iXXzpKcFu7uBEDKtr')
      expect(accepted.size).toBeGreaterThan(0)
    })

    it('should resolve a mint and decimals for every accepted symbol', () => {
      // ARRANGE
      const accepted = [
        ...FIMS_JUPITER_SPEND_SYMBOLS,
        ...Object.values(FIMS_WITHDRAWAL_PROVIDERS).flatMap((provider) => [...provider.acceptedSymbols]),
      ]
      expect.assertions(accepted.length * 2)

      for (const symbol of accepted) {
        // ACT
        const result = FIMS_KNOWN_MINTS[symbol]
        const result1 = FIMS_MINT_DECIMALS[symbol]

        // ASSERT
        expect(result, `missing pinned mint for ${symbol}`).toBeDefined()
        expect(result1, `missing decimals for ${symbol}`).toBeGreaterThan(0)
      }
    })

    it('should prefer EURC then USDC for Coinbase and USDC for Jupiter Spend', () => {
      // ARRANGE
      expect.assertions(3)

      // ACT & ASSERT — order matters: the first symbol is the conversion target.
      expect(FIMS_WITHDRAWAL_PROVIDERS.coinbase.acceptedSymbols.slice(0, 2)).toEqual(['EURC', 'USDC'])
      expect(FIMS_JUPITER_SPEND_SYMBOLS[0]).toBe('USDC')
      expect(FIMS_JUPITER_SPEND_SYMBOLS).not.toContain('SOL')
    })
  })
})
