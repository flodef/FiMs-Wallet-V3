import type { address } from '@solana/kit'
import type { WireTransactionInspection } from '@workspace/solana-client/inspect-wire-transaction'
import { describe, expect, it } from 'vitest'
import { analyzeWireInspection } from '../src/data-access/analyze-wire-inspection.tsx'

const SIGNER = 'Signer11111111111111111111111111111111111' as never as ReturnType<typeof address>
const KNOWN = 'Fe1RpesrtYMJdjwbNXtpVCDNpnFvk6jSic3sJd2aCBng'
const SYSTEM = '11111111111111111111111111111111'
const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'

function makeInspection(overrides?: {
  alreadySignedBy?: string[]
  hasUnresolved?: boolean
  programIds?: string[]
  requiredSigners?: string[]
  reliable?: boolean
  solChanges?: { address: string; change: bigint }[]
  status?: 'failure' | 'success'
  tokenAccounts?: Partial<WireTransactionInspection['simulation']['tokenAccounts'][number]>[]
  tokenChanges?: { account: string; change: bigint; owner?: string }[]
  walletOwnerAfter?: string
}): WireTransactionInspection {
  return {
    alreadySignedBy: (overrides?.alreadySignedBy ?? []) as never[],
    feePayer: SIGNER,
    instructions: [
      {
        accountAddresses: [],
        data: new Uint8Array(),
        hasUnresolvedAccounts: overrides?.hasUnresolved ?? false,
        programId: TOKEN_PROGRAM as never,
      },
    ],
    programIds: (overrides?.programIds ?? [TOKEN_PROGRAM]) as never[],
    requiredSigners: (overrides?.requiredSigners ?? [SIGNER]) as never[],
    simulation: {
      accountsReliable: overrides?.reliable ?? true,
      error: null,
      fee: 5000n,
      logs: [],
      solBalanceChanges: (overrides?.solChanges ?? []).map((row) => ({
        address: row.address,
        change: row.change,
        postBalance: 0n,
        preBalance: 0n,
      })) as never[],
      status: overrides?.status ?? 'success',
      tokenAccounts: (overrides?.tokenAccounts ?? []).map((row) => ({
        account: 'Ata1111111111111111111111111111111111111111',
        delegateAfter: false,
        destroyed: false,
        mint: 'Mint111111111111111111111111111111111111111',
        ...row,
      })) as never[],
      tokenBalanceChanges: (overrides?.tokenChanges ?? []).map((row) => ({
        account: row.account,
        change: row.change,
        decimals: 6,
        mint: 'Mint111111111111111111111111111111111111111',
        owner: row.owner,
        postAmount: 0n,
        preAmount: 0n,
      })) as never[],
      unitsConsumed: 1000n,
      walletOwnerAfter: (overrides?.walletOwnerAfter ?? SYSTEM) as never,
    },
  }
}

const noLabel = () => null

describe('analyze-wire-inspection', () => {
  describe('expected behavior', () => {
    it('should produce no warnings for a clean inspection', () => {
      // ARRANGE
      expect.assertions(3)
      const inspection = makeInspection()

      // ACT
      const result = analyzeWireInspection({ inspection, resolveLabel: noLabel, signer: SIGNER })

      // ASSERT
      expect(result.warnings).toEqual([])
      expect(result.blockSigning).toBe(false)
      expect(result.counterparties).toEqual([])
    })

    it('should label a known counterparty without warning', () => {
      // ARRANGE
      expect.assertions(3)
      const inspection = makeInspection({
        solChanges: [
          { address: SIGNER, change: -100n },
          { address: KNOWN, change: 100n },
        ],
      })
      const resolveLabel = (a: string) => (a === KNOWN ? 'FiMs Tontine' : null)

      // ACT
      const result = analyzeWireInspection({ inspection, resolveLabel, signer: SIGNER })

      // ASSERT
      expect(result.counterparties).toEqual([{ address: KNOWN, label: 'FiMs Tontine' }])
      expect(result.warnings).toEqual([])
      expect(result.blockSigning).toBe(false)
    })

    it('should warn on an unknown counterparty receiving value', () => {
      // ARRANGE
      expect.assertions(2)
      const stranger = 'Stranger1111111111111111111111111111111111'
      const inspection = makeInspection({
        solChanges: [
          { address: SIGNER, change: -100n },
          { address: stranger, change: 100n },
        ],
      })

      // ACT
      const result = analyzeWireInspection({ inspection, resolveLabel: noLabel, signer: SIGNER })

      // ASSERT
      expect(result.warnings).toEqual([{ detail: stranger, id: 'unknownRecipient', severity: 'warning' }])
      expect(result.blockSigning).toBe(false)
    })

    it('should resolve a token counterparty via its ATA owner', () => {
      // ARRANGE
      expect.assertions(2)
      const inspection = makeInspection({
        tokenChanges: [{ account: 'Ata2222222222222222222222222222222222222222', change: 50n, owner: KNOWN }],
      })
      const resolveLabel = (a: string) => (a === KNOWN ? 'FiMs Tontine' : null)

      // ACT
      const result = analyzeWireInspection({ inspection, resolveLabel, signer: SIGNER })

      // ASSERT
      expect(result.counterparties).toEqual([{ address: KNOWN, label: 'FiMs Tontine' }])
      expect(result.warnings).toEqual([])
    })

    it('should warn on an unrecognized program id', () => {
      // ARRANGE
      expect.assertions(2)
      const unknown = 'UnknownProgram111111111111111111111111111'
      const inspection = makeInspection({ programIds: [TOKEN_PROGRAM, unknown] })

      // ACT
      const result = analyzeWireInspection({ inspection, resolveLabel: noLabel, signer: SIGNER })

      // ASSERT
      expect(result.warnings).toEqual([{ detail: unknown, id: 'untrustedProgram', severity: 'warning' }])
      expect(result.programs.find((p) => p.id === TOKEN_PROGRAM)?.name).toBe('Token Program')
    })

    it('should block signing when the wallet account is reassigned', () => {
      // ARRANGE
      expect.assertions(2)
      const inspection = makeInspection({ walletOwnerAfter: 'MaliciousProgram1111111111111111111' })

      // ACT
      const result = analyzeWireInspection({ inspection, resolveLabel: noLabel, signer: SIGNER })

      // ASSERT
      expect(result.blockSigning).toBe(true)
      expect(result.warnings.map((w) => w.id)).toContain('walletReassigned')
    })

    it('should block signing on unresolved accounts', () => {
      // ARRANGE
      expect.assertions(2)
      const inspection = makeInspection({ hasUnresolved: true })

      // ACT
      const result = analyzeWireInspection({ inspection, resolveLabel: noLabel, signer: SIGNER })

      // ASSERT
      expect(result.blockSigning).toBe(true)
      expect(result.warnings.map((w) => w.id)).toContain('unresolvedAccounts')
    })

    it('should block signing on unexpected required signers', () => {
      // ARRANGE
      expect.assertions(2)
      const other = 'OtherSigner1111111111111111111111111111111'
      const inspection = makeInspection({ requiredSigners: [SIGNER, other] })

      // ACT
      const result = analyzeWireInspection({ inspection, resolveLabel: noLabel, signer: SIGNER })

      // ASSERT
      expect(result.blockSigning).toBe(true)
      expect(result.warnings[0]?.id).toBe('unexpectedSigner')
    })

    it('should warn critically when a token account gains a delegate', () => {
      // ARRANGE
      expect.assertions(2)
      const inspection = makeInspection({
        tokenAccounts: [{ delegateAfter: true, ownerBefore: SIGNER as unknown as never }],
      })

      // ACT
      const result = analyzeWireInspection({ inspection, resolveLabel: noLabel, signer: SIGNER })

      // ASSERT
      expect(result.warnings.map((w) => w.id)).toContain('tokenAccountCompromised')
      expect(result.warnings[0]?.severity).toBe('critical')
    })

    it('should warn when simulation fails', () => {
      // ARRANGE
      expect.assertions(2)
      const inspection = makeInspection({ status: 'failure' })

      // ACT
      const result = analyzeWireInspection({ inspection, resolveLabel: noLabel, signer: SIGNER })

      // ASSERT
      expect(result.warnings[0]?.id).toBe('simulationFailed')
      expect(result.blockSigning).toBe(false)
    })

    it('should warn when account states are unreliable', () => {
      // ARRANGE
      expect.assertions(2)
      const inspection = makeInspection({ reliable: false })

      // ACT
      const result = analyzeWireInspection({ inspection, resolveLabel: noLabel, signer: SIGNER })

      // ASSERT
      expect(result.warnings.map((w) => w.id)).toContain('unverifiableChanges')
      expect(result.blockSigning).toBe(false)
    })
  })
})
