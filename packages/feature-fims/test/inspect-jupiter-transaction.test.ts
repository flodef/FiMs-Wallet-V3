import { address } from '@solana/kit'
import { NATIVE_MINT } from '@workspace/solana-client/constants'
import type { inspectWireTransaction } from '@workspace/solana-client/inspect-wire-transaction'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { assertJupiterTransactionSafe, JupiterInspectionError } from '../src/data-access/inspect-jupiter-transaction.ts'

type Inspection = Awaited<ReturnType<typeof inspectWireTransaction>>

const WALLET = address('CCLcWAJX6fubUqGyZWz8dyUGEddRj8h4XZZCNSDzMVx4')
const INPUT_MINT = address('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v')
const OUTPUT_MINT = address('So11111111111111111111111111111111111111112')
const OTHER_MINT = address('Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB')
const SYSTEM_PROGRAM = address('11111111111111111111111111111111')
const TOKEN_PROGRAM = address('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA')

const SAFE_PROGRAMS = [
  SYSTEM_PROGRAM,
  address('ComputeBudget111111111111111111111111111111'),
  TOKEN_PROGRAM,
  address('JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4'),
  address('jupoNjAxXgZ4rjzxzPMP4oxduvQsQtZzyknqvzCNrNu'),
]

function testInspection(overrides: Partial<Inspection> = {}): Inspection {
  return {
    alreadySignedBy: [],
    feePayer: WALLET,
    instructions: [],
    programIds: SAFE_PROGRAMS,
    requiredSigners: [WALLET],
    simulation: {
      accountsReliable: true,
      error: null,
      fee: 5000n,
      logs: [],
      solBalanceChanges: [],
      status: 'success',
      tokenAccounts: [],
      tokenBalanceChanges: [],
      unitsConsumed: 100000n,
      walletOwnerAfter: SYSTEM_PROGRAM,
    },
    ...overrides,
  }
}

function tokenAccountIx(data: number[], accountAddresses: ReturnType<typeof address>[] = []) {
  return {
    accountAddresses,
    data: new Uint8Array(data),
    hasUnresolvedAccounts: false,
    programId: TOKEN_PROGRAM,
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

    it('should accept a transaction crediting at least the expected receive amount', () => {
      // ARRANGE
      expect.assertions(0)
      const inspection = testInspection({
        simulation: {
          ...testInspection().simulation,
          tokenBalanceChanges: [
            {
              account: address('11111111111111111111111111111113'),
              change: 500_000n,
              decimals: 6,
              mint: OUTPUT_MINT,
              owner: WALLET,
              postAmount: 500_000n,
              preAmount: 0n,
            },
          ],
        },
      })

      // ACT & ASSERT
      assertJupiterTransactionSafe({
        account: WALLET,
        expectedReceive: { amount: 500_000n, mint: OUTPUT_MINT },
        inspection,
      })
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

    it('should accept a closed wSOL account when the lamports come back to the wallet', () => {
      // ARRANGE
      expect.assertions(0)
      const wsolAccount = address('11111111111111111111111111111113')
      const inspection = testInspection({
        simulation: {
          ...testInspection().simulation,
          solBalanceChanges: [{ address: WALLET, change: 2_000_000_000n, postBalance: 2_000_000_000n, preBalance: 0n }],
          tokenAccounts: [
            {
              account: wsolAccount,
              closeAuthorityAfter: undefined,
              delegateAfter: false,
              destroyed: true,
              mint: NATIVE_MINT,
              ownerAfter: undefined,
              ownerBefore: WALLET,
            },
          ],
        },
      })

      // ACT & ASSERT
      assertJupiterTransactionSafe({ account: WALLET, inspection })
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

    it('should fail closed when the simulated account states are incomplete', () => {
      // ARRANGE
      expect.assertions(1)
      const inspection = testInspection({
        simulation: { ...testInspection().simulation, accountsReliable: false },
      })

      // ACT & ASSERT
      expect(() => assertJupiterTransactionSafe({ account: WALLET, inspection })).toThrow(JupiterInspectionError)
    })

    it('should reject an instruction with unresolvable account references', () => {
      // ARRANGE
      expect.assertions(1)
      const inspection = testInspection({
        instructions: [
          {
            accountAddresses: [],
            data: new Uint8Array([0]),
            hasUnresolvedAccounts: true,
            programId: TOKEN_PROGRAM,
          },
        ],
      })

      // ACT & ASSERT
      expect(() => assertJupiterTransactionSafe({ account: WALLET, inspection })).toThrow(JupiterInspectionError)
    })

    it('should reject a token approve instruction that delegates wallet funds', () => {
      // ARRANGE
      expect.assertions(1)
      const inspection = testInspection({ instructions: [tokenAccountIx([4])] })

      // ACT & ASSERT
      expect(() => assertJupiterTransactionSafe({ account: WALLET, inspection })).toThrow(JupiterInspectionError)
    })

    it('should reject a token approve-checked instruction', () => {
      // ARRANGE
      expect.assertions(1)
      const inspection = testInspection({ instructions: [tokenAccountIx([13])] })

      // ACT & ASSERT
      expect(() => assertJupiterTransactionSafe({ account: WALLET, inspection })).toThrow(JupiterInspectionError)
    })

    it('should reject a token set-authority instruction', () => {
      // ARRANGE
      expect.assertions(1)
      const inspection = testInspection({ instructions: [tokenAccountIx([6])] })

      // ACT & ASSERT
      expect(() => assertJupiterTransactionSafe({ account: WALLET, inspection })).toThrow(JupiterInspectionError)
    })

    it('should reject a close-account instruction paying a foreign destination', () => {
      // ARRANGE
      expect.assertions(1)
      const foreign = address('11111111111111111111111111111114')
      const inspection = testInspection({
        instructions: [tokenAccountIx([9], [WALLET, foreign, WALLET])],
      })

      // ACT & ASSERT
      expect(() => assertJupiterTransactionSafe({ account: WALLET, inspection })).toThrow(JupiterInspectionError)
    })

    it('should reject a system Assign instruction re-owning the wallet', () => {
      // ARRANGE
      expect.assertions(1)
      const assign = new Uint8Array(4)
      new DataView(assign.buffer).setUint32(0, 1, true)
      const inspection = testInspection({
        instructions: [
          {
            accountAddresses: [WALLET],
            data: assign,
            hasUnresolvedAccounts: false,
            programId: SYSTEM_PROGRAM,
          },
        ],
      })

      // ACT & ASSERT
      expect(() => assertJupiterTransactionSafe({ account: WALLET, inspection })).toThrow(JupiterInspectionError)
    })

    it('should reject a transaction that changes the wallet account owner after simulation', () => {
      // ARRANGE
      expect.assertions(1)
      const inspection = testInspection({
        simulation: { ...testInspection().simulation, walletOwnerAfter: TOKEN_PROGRAM },
      })

      // ACT & ASSERT
      expect(() => assertJupiterTransactionSafe({ account: WALLET, inspection })).toThrow(JupiterInspectionError)
    })

    it('should reject a wallet token account that gains a delegate after simulation', () => {
      // ARRANGE
      expect.assertions(1)
      const inspection = testInspection({
        simulation: {
          ...testInspection().simulation,
          tokenAccounts: [
            {
              account: address('11111111111111111111111111111113'),
              closeAuthorityAfter: undefined,
              delegateAfter: true,
              destroyed: false,
              mint: INPUT_MINT,
              ownerAfter: WALLET,
              ownerBefore: WALLET,
            },
          ],
        },
      })

      // ACT & ASSERT
      expect(() => assertJupiterTransactionSafe({ account: WALLET, inspection })).toThrow(JupiterInspectionError)
    })

    it('should reject a wallet token account closed without being a native unwrap', () => {
      // ARRANGE
      expect.assertions(1)
      const inspection = testInspection({
        simulation: {
          ...testInspection().simulation,
          tokenAccounts: [
            {
              account: address('11111111111111111111111111111113'),
              closeAuthorityAfter: undefined,
              delegateAfter: false,
              destroyed: true,
              mint: INPUT_MINT,
              ownerAfter: undefined,
              ownerBefore: WALLET,
            },
          ],
        },
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

    it('should reject a transaction crediting less than the expected receive amount', () => {
      // ARRANGE
      expect.assertions(1)
      const inspection = testInspection({
        simulation: {
          ...testInspection().simulation,
          tokenBalanceChanges: [
            {
              account: address('11111111111111111111111111111113'),
              change: 100_000n,
              decimals: 6,
              mint: OUTPUT_MINT,
              owner: WALLET,
              postAmount: 100_000n,
              preAmount: 0n,
            },
          ],
        },
      })

      // ACT & ASSERT
      expect(() =>
        assertJupiterTransactionSafe({
          account: WALLET,
          expectedReceive: { amount: 500_000n, mint: OUTPUT_MINT },
          inspection,
        }),
      ).toThrow(JupiterInspectionError)
    })

    it('should reject a transaction crediting the output to a foreign account', () => {
      // ARRANGE
      expect.assertions(1)
      const inspection = testInspection({
        simulation: {
          ...testInspection().simulation,
          tokenBalanceChanges: [
            {
              account: address('11111111111111111111111111111113'),
              change: 600_000n,
              decimals: 6,
              mint: OUTPUT_MINT,
              owner: address('11111111111111111111111111111115'),
              postAmount: 600_000n,
              preAmount: 0n,
            },
          ],
        },
      })

      // ACT & ASSERT
      expect(() =>
        assertJupiterTransactionSafe({
          account: WALLET,
          expectedReceive: { amount: 500_000n, mint: OUTPUT_MINT },
          inspection,
        }),
      ).toThrow(JupiterInspectionError)
    })
  })
})
