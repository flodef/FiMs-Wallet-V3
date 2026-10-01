import { address } from '@solana/kit'
import type { inspectWireTransaction } from '@workspace/solana-client/inspect-wire-transaction'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { assertJupiterTransactionSafe, JupiterInspectionError } from '../src/data-access/inspect-jupiter-transaction.ts'

type Inspection = Awaited<ReturnType<typeof inspectWireTransaction>>

const WALLET = address('CCLcWAJX6fubUqGyZWz8dyUGEddRj8h4XZZCNSDzMVx4')
const INPUT_MINT = address('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v')
const OUTPUT_MINT = address('So11111111111111111111111111111111111111112')
const OTHER_MINT = address('Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB')

const SAFE_PROGRAMS = [
  address('11111111111111111111111111111111'),
  address('ComputeBudget111111111111111111111111111111'),
  address('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'),
  address('JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4'),
  address('jupoNjAxXgZ4rjzxzPMP4oxduvQsQtZzyknqvzCNrNu'),
]

function testInspection(overrides: Partial<Inspection> = {}): Inspection {
  return {
    alreadySignedBy: [],
    feePayer: WALLET,
    programIds: SAFE_PROGRAMS,
    requiredSigners: [WALLET],
    simulation: {
      error: null,
      fee: 5000n,
      logs: [],
      solBalanceChanges: [],
      status: 'success',
      tokenBalanceChanges: [],
      unitsConsumed: 100000n,
    },
    ...overrides,
  }
}

describe('assert-jupiter-transaction-safe', () => {
  describe('expected behavior', () => {
    it('should accept a transaction spending the expected input mint', () => {
      // ARRANGE
      expect.assertions(0)
      const inspection = testInspection({
        simulation: {
          ...testInspection().simulation,
          tokenBalanceChanges: [
            {
              account: address('11111111111111111111111111111113'),
              change: -1_000_000n,
              decimals: 6,
              mint: INPUT_MINT,
              owner: WALLET,
              postAmount: 0n,
              preAmount: 1_000_000n,
            },
          ],
        },
      })

      // ACT & ASSERT
      assertJupiterTransactionSafe({
        account: WALLET,
        expectedSpend: { amount: 1_000_000n, mint: INPUT_MINT },
        inspection,
      })
    })

    it('should accept a native SOL spend within the declared amount plus fee tolerance', () => {
      // ARRANGE
      expect.assertions(0)
      const inspection = testInspection({
        simulation: {
          ...testInspection().simulation,
          solBalanceChanges: [{ address: WALLET, change: -101_000_000n, postBalance: 0n, preBalance: 101_000_000n }],
        },
      })

      // ACT & ASSERT
      assertJupiterTransactionSafe({
        account: WALLET,
        expectedSpend: { amount: 100_000_000n, mint: OUTPUT_MINT },
        inspection,
      })
    })
  })

  describe('unexpected behavior', () => {
    beforeEach(() => {
      vi.spyOn(console, 'log').mockImplementation(() => {})
    })

    afterEach(() => {
      vi.restoreAllMocks()
    })

    it('should reject a transaction whose fee payer is not the wallet', () => {
      // ARRANGE
      expect.assertions(1)
      const inspection = testInspection({ feePayer: address('11111111111111111111111111111114') })

      // ACT & ASSERT
      expect(() => assertJupiterTransactionSafe({ account: WALLET, inspection })).toThrow(JupiterInspectionError)
    })

    it('should reject a transaction requiring an extra signer', () => {
      // ARRANGE
      expect.assertions(1)
      const inspection = testInspection({
        requiredSigners: [WALLET, address('11111111111111111111111111111114')],
      })

      // ACT & ASSERT
      expect(() => assertJupiterTransactionSafe({ account: WALLET, inspection })).toThrow(JupiterInspectionError)
    })

    it('should accept an extra signer that already carries a signature in the transaction', () => {
      // ARRANGE
      expect.assertions(0)
      const ephemeral = address('11111111111111111111111111111114')
      const inspection = testInspection({
        alreadySignedBy: [ephemeral],
        requiredSigners: [WALLET, ephemeral],
      })

      // ACT & ASSERT
      assertJupiterTransactionSafe({ account: WALLET, inspection })
    })

    it('should reject a transaction invoking an unknown program', () => {
      // ARRANGE
      expect.assertions(1)
      const inspection = testInspection({
        programIds: [...SAFE_PROGRAMS, address('DRpbCBMxVnDK7maPM5tGv6uoB3v1sR38MirbP8zPzuv9')],
      })

      // ACT & ASSERT
      expect(() => assertJupiterTransactionSafe({ account: WALLET, inspection })).toThrow(JupiterInspectionError)
    })

    it('should reject a transaction whose simulation failed', () => {
      // ARRANGE
      expect.assertions(1)
      const inspection = testInspection({
        simulation: { ...testInspection().simulation, error: 'InsufficientFunds', status: 'failure' },
      })

      // ACT & ASSERT
      expect(() => assertJupiterTransactionSafe({ account: WALLET, inspection })).toThrow(JupiterInspectionError)
    })

    it('should reject a token drain on an unexpected mint owned by the wallet', () => {
      // ARRANGE
      expect.assertions(1)
      const inspection = testInspection({
        simulation: {
          ...testInspection().simulation,
          tokenBalanceChanges: [
            {
              account: address('11111111111111111111111111111113'),
              change: -500n,
              decimals: 6,
              mint: OTHER_MINT,
              owner: WALLET,
              postAmount: 0n,
              preAmount: 500n,
            },
          ],
        },
      })

      // ACT & ASSERT
      expect(() =>
        assertJupiterTransactionSafe({
          account: WALLET,
          expectedSpend: { amount: 1_000_000n, mint: INPUT_MINT },
          inspection,
        }),
      ).toThrow(JupiterInspectionError)
    })

    it('should reject a SOL drain exceeding the expected spend plus tolerance', () => {
      // ARRANGE
      expect.assertions(1)
      const inspection = testInspection({
        simulation: {
          ...testInspection().simulation,
          solBalanceChanges: [{ address: WALLET, change: -500_000_000n, postBalance: 0n, preBalance: 500_000_000n }],
        },
      })

      // ACT & ASSERT
      expect(() => assertJupiterTransactionSafe({ account: WALLET, inspection })).toThrow(JupiterInspectionError)
    })

    it('should not count outflows from accounts not owned by the wallet', () => {
      // ARRANGE
      expect.assertions(0)
      const inspection = testInspection({
        simulation: {
          ...testInspection().simulation,
          tokenBalanceChanges: [
            {
              account: address('11111111111111111111111111111113'),
              change: -500n,
              decimals: 6,
              mint: OTHER_MINT,
              owner: address('11111111111111111111111111111115'),
              postAmount: 0n,
              preAmount: 500n,
            },
          ],
        },
      })

      // ACT & ASSERT
      assertJupiterTransactionSafe({ account: WALLET, inspection })
    })
  })
})
