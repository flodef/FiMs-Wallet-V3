import { address, getAddressDecoder } from '@solana/kit'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// buildDepositIx resolves each mint's token program on-chain — the PoC mints
// are all legacy SPL, so fetchMint always reports the canonical program.
vi.mock('@solana-program/token', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@solana-program/token')>()
  return {
    ...actual,
    fetchMint: vi.fn(async () => ({ programAddress: address('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA') })),
  }
})

// The mocked fetchMint never touches the rpc handle.
const rpc = {} as never

import {
  buildDepositIx,
  FIMS_STRATEGY_PROGRAM_ID,
  FIMS_STRATEGY_TIP_LAMPORTS,
  type FimsStrategyState,
  parseStrategyState,
  statePda,
  vaultPda,
} from '../src/data-access/fims-strategy.ts'

const PK = (n: number) => Uint8Array.from({ length: 32 }, (_, i) => (n + i) % 256)
const u64le = (n: bigint) => new Uint8Array(new BigUint64Array([n]).buffer)
const u32le = (n: number) => new Uint8Array(new Uint32Array([n]).buffer)
const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let off = 0
  for (const p of parts) {
    out.set(p, off)
    off += p.length
  }
  return out
}
const vec = (items: Uint8Array[]) => concat(u32le(items.length), ...items)

// StrategyConfig: vaultId u64 | positionId u32 | vaultsProgram | positionNftMint
// | collateralMint | borrowMint | stableMint | shareMint | maxDebt u64
const strategyBytes = () =>
  concat(
    u64le(52n),
    u32le(124),
    PK(10),
    PK(11),
    PK(12), // collateral
    PK(13), // borrow
    PK(14), // stable
    PK(15), // share
    u64le(1_000_000n),
  )

const DISC = Uint8Array.of(0, 0, 0, 0, 0, 0, 0, 0)

const stateBytes = () =>
  concat(
    DISC,
    PK(1), // admin
    PK(2), // delegate
    PK(3), // guardian
    PK(4), // treasury
    Uint8Array.of(0), // paused
    vec([PK(20)]), // allowed_programs
    vec([PK(30), PK(31)]), // member_whitelist
    vec([strategyBytes()]),
    vec([concat(PK(13), PK(14), Uint8Array.of(50, 0))]), // mint pairs
  )

const base58 = (bytes: Uint8Array) => getAddressDecoder().decode(bytes)

const MEMBER = address('CCLcWAJX6fubUqGyZWz8dyUGEddRj8h4XZZCNSDzMVx4')

const state = (strategies = 1): FimsStrategyState => ({
  delegate: address(base58(PK(2))),
  paused: false,
  strategies: Array.from({ length: strategies }, (_, i) => ({
    collateralMint: address(base58(PK(12 + i * 10))),
    shareMint: address(base58(PK(15 + i * 10))),
  })),
})

describe('parse-strategy-state', () => {
  describe('expected behavior', () => {
    it('should decode the delegate and strategy mints in Rust field order', () => {
      // ARRANGE
      expect.assertions(4)
      const data = stateBytes()

      // ACT
      const result = parseStrategyState(data)

      // ASSERT
      expect(result.delegate).toBe(base58(PK(2)))
      expect(result.paused).toBe(false)
      expect(result.strategies).toHaveLength(1)
      expect(result.strategies[0]).toEqual({
        collateralMint: base58(PK(12)),
        shareMint: base58(PK(15)),
      })
    })
  })
})

describe('build-deposit-ix', () => {
  describe('expected behavior', () => {
    it('should encode the anchor discriminator, strategy index, amount and tip', async () => {
      // ARRANGE
      expect.assertions(4)
      const amount = 1_234_567_890n
      const expectedDisc = new Uint8Array(
        await crypto.subtle.digest('SHA-256', new TextEncoder().encode('global:deposit')),
      ).slice(0, 8)

      // ACT
      const ix = await buildDepositIx(rpc, { amount, member: MEMBER, state: state(), strategyIndex: 0 })

      // ASSERT
      expect(ix.data?.length).toBe(25) // disc(8) + u8 + u64 + u64
      expect(Array.from(ix.data?.slice(0, 8) ?? [])).toEqual(Array.from(expectedDisc))
      expect(ix.data?.[8]).toBe(0)
      const data = ix.data ?? new Uint8Array()
      expect(new DataView(data.buffer, data.byteOffset + 9).getBigUint64(0, true)).toBe(amount)
    })

    it('should build the 13 accounts matching the Rust Deposit context', async () => {
      // ARRANGE
      expect.assertions(9)
      const s = state()

      // ACT
      const ix = await buildDepositIx(rpc, { amount: 1n, member: MEMBER, state: s, strategyIndex: 0 })

      // ASSERT — member, state, member ATA, vault, vault ATA, delegate,
      // share mint, member share ATA, member_deposit PDA, token programs, system/ATA
      expect(ix.accounts).toHaveLength(14)
      expect(ix.accounts?.[0]).toMatchObject({ address: MEMBER, role: 3 })
      expect(ix.accounts?.[1]).toMatchObject({ address: await statePda(), role: 0 })
      expect(ix.accounts?.[3]).toMatchObject({ address: await vaultPda(), role: 1 })
      expect(ix.accounts?.[5]).toMatchObject({ address: s.delegate, role: 1 })
      expect(ix.accounts?.[6]).toMatchObject({ address: s.strategies[0]?.shareMint, role: 0 })
      expect(ix.accounts?.[9]?.address).toBe('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA')
      expect(ix.accounts?.[10]?.address).toBe('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA')
      expect(ix.programAddress).toBe(FIMS_STRATEGY_PROGRAM_ID)
    })

    it('should derive a distinct member_deposit PDA per member and strategy', async () => {
      // ARRANGE
      expect.assertions(2)
      const other = address('So11111111111111111111111111111111111111112')

      // ACT
      const ixA = await buildDepositIx(rpc, { amount: 1n, member: MEMBER, state: state(), strategyIndex: 0 })
      const ixB = await buildDepositIx(rpc, { amount: 1n, member: other, state: state(), strategyIndex: 0 })
      const ixC = await buildDepositIx(rpc, { amount: 1n, member: MEMBER, state: state(2), strategyIndex: 1 })

      // ASSERT
      expect(ixA.accounts?.[8]?.address).not.toBe(ixB.accounts?.[8]?.address)
      expect(ixA.accounts?.[8]?.address).not.toBe(ixC.accounts?.[8]?.address)
    })

    it('should honor a custom tip lamports override', async () => {
      // ARRANGE
      expect.assertions(2)
      const tip = 42_000n

      // ACT
      const ix = await buildDepositIx(rpc, { amount: 1n, member: MEMBER, state: state(), strategyIndex: 0, tip })
      const ixDefault = await buildDepositIx(rpc, { amount: 1n, member: MEMBER, state: state(), strategyIndex: 0 })

      // ASSERT
      const data = ix.data ?? new Uint8Array()
      const dataDefault = ixDefault.data ?? new Uint8Array()
      expect(new DataView(data.buffer, data.byteOffset + 17).getBigUint64(0, true)).toBe(tip)
      expect(new DataView(dataDefault.buffer, dataDefault.byteOffset + 17).getBigUint64(0, true)).toBe(
        FIMS_STRATEGY_TIP_LAMPORTS,
      )
    })
  })

  describe('unexpected behavior', () => {
    beforeEach(() => {
      vi.spyOn(console, 'log').mockImplementation(() => {})
    })
    afterEach(() => {
      vi.restoreAllMocks()
    })

    it('should reject an unknown strategy index', async () => {
      // ARRANGE
      expect.assertions(1)

      // ACT & ASSERT
      await expect(
        buildDepositIx(rpc, { amount: 1n, member: MEMBER, state: state(), strategyIndex: 7 }),
      ).rejects.toThrow('unknown strategy index')
    })

    it('should reject a malformed member address', async () => {
      // ARRANGE
      expect.assertions(1)

      // ACT & ASSERT
      await expect(
        buildDepositIx(rpc, { amount: 1n, member: '!!!not-base58!!!' as never, state: state(), strategyIndex: 0 }),
      ).rejects.toThrow()
    })
  })
})
