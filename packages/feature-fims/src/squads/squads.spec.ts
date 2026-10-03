// @vitest-environment node
import { AccountRole, type Address } from '@solana/kit'
import { PublicKey, TransactionInstruction } from '@solana/web3.js'
import { accounts as squadsAccounts } from '@sqds/multisig'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  decodeSquadsMultisig,
  decodeSquadsProposal,
  decodeSquadsSpendingLimit,
  squadsMultisigPda,
  squadsVaultPda,
  toKitInstruction,
} from './squads.ts'

function testPubkey(seed: number): PublicKey {
  return PublicKey.unique() ?? new PublicKey(new Uint8Array(32).fill(seed))
}

describe('to-kit-instruction', () => {
  describe('expected behavior', () => {
    it('should map program address, data and each account role', () => {
      // ARRANGE
      expect.assertions(6)
      const program = testPubkey(1)
      const writableSigner = testPubkey(2)
      const writable = testPubkey(3)
      const readonlySigner = testPubkey(4)
      const readonly = testPubkey(5)
      const instruction = new TransactionInstruction({
        data: Buffer.from([9, 8, 7]),
        keys: [
          { isSigner: true, isWritable: true, pubkey: writableSigner },
          { isSigner: false, isWritable: true, pubkey: writable },
          { isSigner: true, isWritable: false, pubkey: readonlySigner },
          { isSigner: false, isWritable: false, pubkey: readonly },
        ],
        programId: program,
      })

      // ACT
      const result = toKitInstruction(instruction)

      // ASSERT
      expect(result.programAddress).toBe(program.toBase58())
      expect([...(result.data ?? [])]).toEqual([9, 8, 7])
      expect(result.accounts?.[0]?.role).toBe(AccountRole.WRITABLE_SIGNER)
      expect(result.accounts?.[1]?.role).toBe(AccountRole.WRITABLE)
      expect(result.accounts?.[2]?.role).toBe(AccountRole.READONLY_SIGNER)
      expect(result.accounts?.[3]?.role).toBe(AccountRole.READONLY)
    })
  })
})

describe('squads-pdas', () => {
  describe('expected behavior', () => {
    it('should derive a deterministic multisig pda for a create key', () => {
      // ARRANGE
      expect.assertions(2)
      const createKey = testPubkey(6).toBase58() as Address

      // ACT
      const result1 = squadsMultisigPda(createKey)
      const result2 = squadsMultisigPda(createKey)

      // ASSERT
      expect(result1).toBe(result2)
      expect(result1.length).toBeGreaterThan(30)
    })

    it('should derive different vaults for different authority indexes', () => {
      // ARRANGE
      expect.assertions(1)
      const multisigPda = squadsMultisigPda(testPubkey(7).toBase58() as Address)

      // ACT
      const result0 = squadsVaultPda(multisigPda, 0)
      const result1 = squadsVaultPda(multisigPda, 1)

      // ASSERT
      expect(result0).not.toBe(result1)
    })
  })
})

describe('decode-squads-multisig', () => {
  describe('expected behavior', () => {
    it('should decode members, threshold and transaction index', () => {
      // ARRANGE
      expect.assertions(4)
      const memberA = testPubkey(8)
      const memberB = testPubkey(9)
      const [data] = squadsAccounts.multisigBeet.serialize({
        accountDiscriminator: squadsAccounts.multisigDiscriminator,
        bump: 255,
        configAuthority: PublicKey.default,
        createKey: testPubkey(10),
        members: [
          { key: memberA, permissions: { mask: 7 } },
          { key: memberB, permissions: { mask: 7 } },
        ],
        rentCollector: null,
        staleTransactionIndex: 0,
        threshold: 2,
        timeLock: 0,
        transactionIndex: 5,
      })

      // ACT
      const result = decodeSquadsMultisig(new Uint8Array(data))

      // ASSERT
      expect(result.threshold).toBe(2)
      expect(result.members.map((member) => member.key)).toEqual([memberA.toBase58(), memberB.toBase58()])
      expect(result.transactionIndex).toBe(5n)
      expect(result.members[0]?.permissions).toBe(7)
    })
  })

  describe('unexpected behavior', () => {
    beforeEach(() => {
      vi.spyOn(console, 'log').mockImplementation(() => {})
    })

    afterEach(() => {
      vi.restoreAllMocks()
    })

    it('should throw on truncated account data', () => {
      // ARRANGE
      expect.assertions(1)
      const data = new Uint8Array(12)

      // ACT & ASSERT
      expect(() => decodeSquadsMultisig(data)).toThrow()
    })
  })
})

describe('decode-squads-proposal', () => {
  describe('expected behavior', () => {
    it('should map enum kinds to proposal statuses', () => {
      // ARRANGE
      expect.assertions(4)
      const multisig = testPubkey(11)
      const [data] = squadsAccounts.proposalBeet.serialize({
        accountDiscriminator: squadsAccounts.proposalDiscriminator,
        approved: [testPubkey(12)],
        bump: 1,
        cancelled: [],
        multisig,
        rejected: [],
        status: { __kind: 'Approved', timestamp: 1 },
        transactionIndex: 7,
      })

      // ACT
      const result = decodeSquadsProposal(new Uint8Array(data), 'prop' as Address)

      // ASSERT
      expect(result.status).toBe('approved')
      expect(result.index).toBe(7n)
      expect(result.multisig).toBe(multisig.toBase58())
      expect(result.approved).toHaveLength(1)
    })
  })
})

describe('decode-squads-spending-limit', () => {
  describe('expected behavior', () => {
    it('should decode amount, period and remaining amount', () => {
      // ARRANGE
      expect.assertions(4)
      const [data] = squadsAccounts.spendingLimitBeet.serialize({
        accountDiscriminator: squadsAccounts.spendingLimitDiscriminator,
        amount: 1_000_000,
        bump: 1,
        createKey: testPubkey(13),
        destinations: [testPubkey(14)],
        lastReset: 0,
        members: [testPubkey(15)],
        mint: PublicKey.default,
        multisig: testPubkey(16),
        period: 2,
        remainingAmount: 750_000,
        vaultIndex: 0,
      })

      // ACT
      const result = decodeSquadsSpendingLimit(new Uint8Array(data))

      // ASSERT
      expect(result.amount).toBe(1_000_000n)
      expect(result.remainingAmount).toBe(750_000n)
      expect(result.period).toBe('week')
      expect(result.destinations).toHaveLength(1)
    })
  })
})
