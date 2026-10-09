// cspell:ignore unstub AAEC

import { AccountRole, type Instruction } from '@solana/kit'
import { findAssociatedTokenPda } from '@solana-program/token'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WrappedProductConfig } from './custodial.js'
import { assertSafeYieldInstructions, yieldInstructions } from './yield-placement.js'

const SIGNER = 'GyU9ZpTL3ce8kfS6XSpoiXaiiGb9svJfFEWer33SMmPS' as never
const CONFIG = {
  backingMint: 'HzwqbKZw8HxMN6bF2yFZNrht3c2iXXzpKcFu7uBEDKtr',
  mint: 'mScYnvWBaGK6jd9ufw2EN7fjDYtAqMeRhJFV6dQ7q1k',
  symbol: 'EURF',
  units: 1_000_000n,
} as WrappedProductConfig

const JUPITER_LEND = 'jup3YeL8QhtSx1e253b2FDvsMNC87fDrgQZivbrndc9'
const KAMINO_LEND = 'KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD'

function ixResponse(programId = JUPITER_LEND) {
  return new Response(
    JSON.stringify({
      instructions: [
        {
          accounts: [
            { isSigner: true, isWritable: true, pubkey: SIGNER },
            { isSigner: false, isWritable: true, pubkey: '9LUr1oUuecMEm3zc8XezRPmoyQRXZuRt1bk6mv8t2BD9' },
            { isSigner: false, isWritable: false, pubkey: 'DK4244TRxk9FAVccJ4cpEYje5j5nFVa9XGygoovxo37k' },
          ],
          data: 'AAEC',
          programId,
        },
      ],
    }),
    { status: 200 },
  )
}

describe('yieldInstructions', () => {
  beforeEach(() => {
    vi.unstubAllEnvs()
    vi.stubGlobal('fetch', vi.fn())
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
  })

  describe('expected behavior', () => {
    it('should return no instructions when yield is not configured', async () => {
      // ARRANGE
      expect.assertions(2)

      // ACT
      const result = await yieldInstructions('fims-eur', 'deposit', CONFIG, SIGNER, 1_000_000n)

      // ASSERT
      expect(result).toEqual([])
      expect(fetch).not.toHaveBeenCalled()
    })

    it('should post to the Jupiter Earn endpoint and convert instruction roles', async () => {
      // ARRANGE
      expect.assertions(6)
      vi.stubEnv('FIMS_EURO_YIELD', 'jupiter-earn')
      vi.mocked(fetch).mockResolvedValueOnce(ixResponse())

      // ACT
      const result = await yieldInstructions('fims-eur', 'deposit', CONFIG, SIGNER, 1_000_000n)

      // ASSERT
      expect(fetch).toHaveBeenCalledWith(
        'https://api.jup.ag/lend/v1/earn/deposit-instructions',
        expect.objectContaining({
          body: JSON.stringify({ amount: '1000000', asset: CONFIG.backingMint, signer: SIGNER }),
        }),
      )
      expect(result).toHaveLength(1)
      expect(result[0]?.programAddress).toBe('jup3YeL8QhtSx1e253b2FDvsMNC87fDrgQZivbrndc9')
      expect(result[0]?.accounts?.[0]?.role).toBe(AccountRole.WRITABLE_SIGNER)
      expect(result[0]?.accounts?.[1]?.role).toBe(AccountRole.WRITABLE)
      expect(result[0]?.accounts?.[2]?.role).toBe(AccountRole.READONLY)
    })

    it('should call withdraw-instructions for the withdraw action', async () => {
      // ARRANGE
      expect.assertions(1)
      vi.stubEnv('FIMS_EURO_YIELD', 'jupiter-earn')
      vi.mocked(fetch).mockResolvedValueOnce(ixResponse())

      // ACT
      await yieldInstructions('fims-eur', 'withdraw', CONFIG, SIGNER, 1n)

      // ASSERT
      expect(fetch).toHaveBeenCalledWith('https://api.jup.ag/lend/v1/earn/withdraw-instructions', expect.anything())
    })

    it('should post the decimal amount to the Kamino ktx endpoint', async () => {
      // ARRANGE
      expect.assertions(2)
      vi.stubEnv('FIMS_USD_YIELD', 'kamino')
      vi.stubEnv('FIMS_USD_YIELD_MARKET', 'MarketAddr1111111111111111111111111111111')
      vi.stubEnv('FIMS_USD_YIELD_RESERVE', 'ReserveAddr1111111111111111111111111111')
      vi.mocked(fetch).mockResolvedValueOnce(ixResponse(KAMINO_LEND))

      // ACT
      const result = await yieldInstructions('fims-usd', 'deposit', CONFIG, SIGNER, 1_500_000n)

      // ASSERT
      expect(fetch).toHaveBeenCalledWith(
        'https://api.kamino.finance/ktx/klend/deposit-instructions',
        expect.objectContaining({
          body: JSON.stringify({
            amount: '1.5',
            market: 'MarketAddr1111111111111111111111111111111',
            reserve: 'ReserveAddr1111111111111111111111111111',
            wallet: SIGNER,
          }),
        }),
      )
      expect(result).toHaveLength(1)
    })
  })

  describe('unexpected behavior', () => {
    beforeEach(() => {
      vi.spyOn(console, 'log').mockImplementation(() => {})
    })

    afterEach(() => {
      vi.restoreAllMocks()
    })

    it('should throw when Kamino market env is missing', async () => {
      // ARRANGE
      expect.assertions(1)
      vi.stubEnv('FIMS_USD_YIELD', 'kamino')

      // ACT & ASSERT
      await expect(yieldInstructions('fims-usd', 'deposit', CONFIG, SIGNER, 1n)).rejects.toThrow(
        'FIMS_USD_YIELD_MARKET / FIMS_USD_YIELD_RESERVE are not configured',
      )
    })

    it('should throw on a non-ok response', async () => {
      // ARRANGE
      expect.assertions(1)
      vi.stubEnv('FIMS_EURO_YIELD', 'jupiter-earn')
      vi.mocked(fetch).mockResolvedValueOnce(new Response('boom', { status: 400 }))

      // ACT & ASSERT
      await expect(yieldInstructions('fims-eur', 'deposit', CONFIG, SIGNER, 1n)).rejects.toThrow('provider API 400')
    })

    it('should throw when the response carries no instructions', async () => {
      // ARRANGE
      expect.assertions(1)
      vi.stubEnv('FIMS_EURO_YIELD', 'jupiter-earn')
      vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({}), { status: 200 }))

      // ACT & ASSERT
      await expect(yieldInstructions('fims-eur', 'deposit', CONFIG, SIGNER, 1n)).rejects.toThrow(
        'provider API returned no instructions',
      )
    })

    it('should throw when the provider returns a non-allowlisted program', async () => {
      // ARRANGE
      expect.assertions(1)
      vi.stubEnv('FIMS_EURO_YIELD', 'jupiter-earn')
      vi.mocked(fetch).mockResolvedValueOnce(ixResponse('11111111111111111111111111111111'))

      // ACT & ASSERT
      await expect(yieldInstructions('fims-eur', 'deposit', CONFIG, SIGNER, 1n)).rejects.toThrow(
        'non-allowlisted program',
      )
    })

    it('should throw when the provider demands an extra signer', async () => {
      // ARRANGE
      expect.assertions(1)
      vi.stubEnv('FIMS_EURO_YIELD', 'jupiter-earn')
      vi.mocked(fetch).mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            instructions: [
              {
                accounts: [
                  { isSigner: true, isWritable: true, pubkey: SIGNER },
                  { isSigner: true, isWritable: false, pubkey: '9LUr1oUuecMEm3zc8XezRPmoyQRXZuRt1bk6mv8t2BD9' },
                ],
                data: 'AAEC',
                programId: JUPITER_LEND,
              },
            ],
          }),
          { status: 200 },
        ),
      )

      // ACT & ASSERT
      await expect(yieldInstructions('fims-eur', 'deposit', CONFIG, SIGNER, 1n)).rejects.toThrow('extra signer')
    })
  })
})

describe('assertSafeYieldInstructions', () => {
  const meta = (pubkey: string, isSigner = false, isWritable = false) => ({
    address: pubkey as never,
    role: isSigner
      ? isWritable
        ? AccountRole.WRITABLE_SIGNER
        : AccountRole.READONLY_SIGNER
      : isWritable
        ? AccountRole.WRITABLE
        : AccountRole.READONLY,
  })

  async function transferChecked(source: string, mint: string, authority: string): Promise<Instruction> {
    const data = new Uint8Array(10)
    data[0] = 12
    return {
      accounts: [meta(source), meta(mint), meta('9LUr1oUuecMEm3zc8XezRPmoyQRXZuRt1bk6mv8t2BD9'), meta(authority)],
      data,
      programAddress: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' as never,
    }
  }

  describe('expected behavior', () => {
    it('should accept a TransferChecked sourcing the custody ATA of its mint', async () => {
      // ARRANGE
      expect.assertions(1)
      const mint = 'HzwqbKZw8HxMN6bF2yFZNrht3c2iXXzpKcFu7uBEDKtr'
      const [source] = await findAssociatedTokenPda({
        mint: mint as never,
        owner: SIGNER,
        tokenProgram: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' as never,
      })
      const ix = await transferChecked(source, mint, SIGNER)

      // ACT
      const result = await assertSafeYieldInstructions('jupiter-earn', [ix], SIGNER)

      // ASSERT
      expect(result).toBeUndefined()
    })
  })

  describe('unexpected behavior', () => {
    beforeEach(() => {
      vi.spyOn(console, 'log').mockImplementation(() => {})
    })

    afterEach(() => {
      vi.restoreAllMocks()
    })

    it('should reject the System program', async () => {
      // ARRANGE
      expect.assertions(1)
      const ix: Instruction = {
        accounts: [],
        data: new Uint8Array([0]),
        programAddress: '11111111111111111111111111111111' as never,
      }

      // ACT & ASSERT
      await expect(assertSafeYieldInstructions('jupiter-earn', [ix], SIGNER)).rejects.toThrow('non-allowlisted program')
    })

    it('should reject a SetAuthority token instruction', async () => {
      // ARRANGE
      expect.assertions(1)
      const data = new Uint8Array(2)
      data[0] = 6
      const ix: Instruction = {
        accounts: [meta('9LUr1oUuecMEm3zc8XezRPmoyQRXZuRt1bk6mv8t2BD9'), meta(SIGNER)],
        data,
        programAddress: 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb' as never,
      }

      // ACT & ASSERT
      await expect(assertSafeYieldInstructions('jupiter-earn', [ix], SIGNER)).rejects.toThrow(
        'forbidden token instruction',
      )
    })

    it('should reject a TransferChecked debiting a non-custody source', async () => {
      // ARRANGE
      expect.assertions(1)
      const ix = await transferChecked(
        'DK4244TRxk9FAVccJ4cpEYje5j5nFVa9XGygoovxo37k',
        'HzwqbKZw8HxMN6bF2yFZNrht3c2iXXzpKcFu7uBEDKtr',
        SIGNER,
      )

      // ACT & ASSERT
      await expect(assertSafeYieldInstructions('jupiter-earn', [ix], SIGNER)).rejects.toThrow('non-custody source')
    })

    it('should reject a TransferChecked signed by another authority', async () => {
      // ARRANGE
      expect.assertions(1)
      const mint = 'HzwqbKZw8HxMN6bF2yFZNrht3c2iXXzpKcFu7uBEDKtr'
      const [source] = await findAssociatedTokenPda({
        mint: mint as never,
        owner: SIGNER,
        tokenProgram: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' as never,
      })
      const ix = await transferChecked(source, mint, '9LUr1oUuecMEm3zc8XezRPmoyQRXZuRt1bk6mv8t2BD9')

      // ACT & ASSERT
      await expect(assertSafeYieldInstructions('jupiter-earn', [ix], SIGNER)).rejects.toThrow(
        'malformed TransferChecked metas',
      )
    })
  })
})
