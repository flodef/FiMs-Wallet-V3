// cspell:ignore unstub
import type { Address } from '@solana/kit'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { assertSolanaPayTransactionSafe } from '../src/assert-solana-pay-transaction-safe.ts'
import type { WireTransactionInspection } from '../src/inspect-wire-transaction.ts'

const ACCOUNT = 'GyU9ZpTL3ce8kfS6XSpoiXaiiGb9svJfFEWer33SMmPS' as Address
const SYSTEM = '11111111111111111111111111111111' as Address
const TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' as Address
const FOREIGN = 'Fe1RpesrtYMJdjwbNXtpVCDNpnFvk6jSic3sJd2aCBng' as Address

function makeInspection(overrides: Partial<WireTransactionInspection> = {}): WireTransactionInspection {
  return {
    alreadySignedBy: [],
    feePayer: ACCOUNT,
    instructions: [],
    programIds: [TOKEN],
    requiredSigners: [ACCOUNT],
    simulation: {
      accountsReliable: true,
      error: null,
      fee: 5000n,
      logs: [],
      solBalanceChanges: [],
      status: 'success',
      tokenAccounts: [],
      tokenBalanceChanges: [],
      unitsConsumed: 1000n,
      walletOwnerAfter: SYSTEM,
    },
    ...overrides,
  }
}

describe('assertSolanaPayTransactionSafe', () => {
  describe('expected behavior', () => {
    it('should accept a clean simulated transaction signed by the wallet', () => {
      // ARRANGE
      expect.assertions(1)
      const inspection = makeInspection()

      // ACT & ASSERT
      expect(() => assertSolanaPayTransactionSafe({ account: ACCOUNT, inspection })).not.toThrow()
    })

    it('should accept another required signer when it is already signed', () => {
      // ARRANGE
      expect.assertions(1)
      const inspection = makeInspection({
        alreadySignedBy: [FOREIGN],
        requiredSigners: [ACCOUNT, FOREIGN],
      })

      // ACT & ASSERT
      expect(() => assertSolanaPayTransactionSafe({ account: ACCOUNT, inspection })).not.toThrow()
    })
  })

  describe('unexpected behavior', () => {
    beforeEach(() => {
      vi.spyOn(console, 'log').mockImplementation(() => {})
    })

    afterEach(() => {
      vi.restoreAllMocks()
    })

    it('should throw when the wallet is not the fee payer', () => {
      // ARRANGE
      expect.assertions(1)
      const inspection = makeInspection({ feePayer: FOREIGN })

      // ACT & ASSERT
      expect(() => assertSolanaPayTransactionSafe({ account: ACCOUNT, inspection })).toThrow('fee payer')
    })

    it('should throw when an unsigned foreign signer is required', () => {
      // ARRANGE
      expect.assertions(1)
      const inspection = makeInspection({ requiredSigners: [ACCOUNT, FOREIGN] })

      // ACT & ASSERT
      expect(() => assertSolanaPayTransactionSafe({ account: ACCOUNT, inspection })).toThrow(
        'unexpected required signer',
      )
    })

    it('should throw on an unknown program id', () => {
      // ARRANGE
      expect.assertions(1)
      const inspection = makeInspection({ programIds: [TOKEN, FOREIGN] })

      // ACT & ASSERT
      expect(() => assertSolanaPayTransactionSafe({ account: ACCOUNT, inspection })).toThrow('unknown program')
    })

    it('should throw when the simulation failed', () => {
      // ARRANGE
      expect.assertions(1)
      const inspection = makeInspection()
      inspection.simulation.status = 'failure'
      inspection.simulation.error = 'InstructionError'

      // ACT & ASSERT
      expect(() => assertSolanaPayTransactionSafe({ account: ACCOUNT, inspection })).toThrow('simulation failed')
    })

    it('should throw when simulated account states are incomplete', () => {
      // ARRANGE
      expect.assertions(1)
      const inspection = makeInspection()
      inspection.simulation.accountsReliable = false

      // ACT & ASSERT
      expect(() => assertSolanaPayTransactionSafe({ account: ACCOUNT, inspection })).toThrow('incomplete')
    })

    it('should throw on an approve instruction delegating wallet funds', () => {
      // ARRANGE
      expect.assertions(1)
      const inspection = makeInspection({
        instructions: [
          {
            accountAddresses: [ACCOUNT, FOREIGN],
            data: new Uint8Array([4]),
            hasUnresolvedAccounts: false,
            programId: TOKEN,
          },
        ],
      })

      // ACT & ASSERT
      expect(() => assertSolanaPayTransactionSafe({ account: ACCOUNT, inspection })).toThrow('approve')
    })

    it('should throw on a close-account paying someone else', () => {
      // ARRANGE
      expect.assertions(1)
      const inspection = makeInspection({
        instructions: [
          {
            accountAddresses: [ACCOUNT, FOREIGN, ACCOUNT],
            data: new Uint8Array([9]),
            hasUnresolvedAccounts: false,
            programId: TOKEN,
          },
        ],
      })

      // ACT & ASSERT
      expect(() => assertSolanaPayTransactionSafe({ account: ACCOUNT, inspection })).toThrow('close-account')
    })

    it('should throw on a system assign instruction', () => {
      // ARRANGE
      expect.assertions(1)
      const data = new Uint8Array(4)
      new DataView(data.buffer).setUint32(0, 1, true)
      const inspection = makeInspection({
        instructions: [{ accountAddresses: [ACCOUNT], data, hasUnresolvedAccounts: false, programId: SYSTEM }],
        programIds: [SYSTEM],
      })

      // ACT & ASSERT
      expect(() => assertSolanaPayTransactionSafe({ account: ACCOUNT, inspection })).toThrow('system instruction')
    })

    it('should throw when the wallet account owner changes', () => {
      // ARRANGE
      expect.assertions(1)
      const inspection = makeInspection()
      inspection.simulation.walletOwnerAfter = TOKEN

      // ACT & ASSERT
      expect(() => assertSolanaPayTransactionSafe({ account: ACCOUNT, inspection })).toThrow('owner changed')
    })

    it('should throw on unresolved account references', () => {
      // ARRANGE
      expect.assertions(1)
      const inspection = makeInspection({
        instructions: [
          {
            accountAddresses: [ACCOUNT, undefined],
            data: new Uint8Array(),
            hasUnresolvedAccounts: true,
            programId: TOKEN,
          },
        ],
      })

      // ACT & ASSERT
      expect(() => assertSolanaPayTransactionSafe({ account: ACCOUNT, inspection })).toThrow('unresolvable')
    })
  })
})
