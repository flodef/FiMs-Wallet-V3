import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { encodeBase58, issueSharesIx, parseMemberDeposit, parseStrategyState, vaultAta } from './strategy-delegate'

const PK = (n: number) => Uint8Array.from({ length: 32 }, (_, i) => (n + i) % 256)
const u64le = (n: bigint) => new Uint8Array(new BigUint64Array([n]).buffer)
const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let off = 0
  for (const p of parts) {
    out.set(p, off)
    off += p.length
  }
  return out
}
const vec = (items: Uint8Array[]) => concat(new Uint8Array(new Uint32Array([items.length]).buffer), ...items)

// StrategyConfig: vaultId u64 | positionId u32 | vaultsProgram | positionNftMint
// | collateralMint | borrowMint | stableMint | shareMint | maxDebt u64
const strategyBytes = () =>
  concat(
    u64le(52n),
    new Uint8Array(new Uint32Array([124]).buffer),
    PK(10),
    PK(11),
    PK(12), // collateral
    PK(13), // borrow
    PK(14), // stable
    PK(15), // share
    u64le(1_000_000n),
  )

// MintPair: from | to | max_deviation_bps u16 | daily_cap u64
const pairBytes = () => concat(PK(13), PK(14), Uint8Array.of(50, 0), u64le(7_500_000n))

const DISC = Uint8Array.of(0, 0, 0, 0, 0, 0, 0, 0) // 8-byte anchor discriminator

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
    vec([pairBytes()]),
  )

describe('parseStrategyState', () => {
  describe('expected behavior', () => {
    it('should decode all fields the keeper needs', () => {
      // ARRANGE
      expect.assertions(7)
      const data = stateBytes()

      // ACT
      const state = parseStrategyState(data)

      // ASSERT
      expect(state.delegate).toBe(encodeBase58(PK(2)))
      expect(state.treasury).toBe(encodeBase58(PK(4)))
      expect(state.paused).toBe(false)
      expect(state.memberWhitelist).toEqual([encodeBase58(PK(30)), encodeBase58(PK(31))])
      expect(state.strategies[0]).toMatchObject({
        collateralMint: encodeBase58(PK(12)),
        positionId: 124,
        shareMint: encodeBase58(PK(15)),
        vaultId: 52n,
      })
      expect(state.mintPairs[0]?.maxDeviationBps).toBe(50)
      expect(state.mintPairs[0]?.dailyCap).toBe(7_500_000n)
    })
  })
})

describe('parseMemberDeposit', () => {
  describe('expected behavior', () => {
    it('should decode member, strategy index and pending amount', () => {
      // ARRANGE
      expect.assertions(3)
      const data = concat(DISC, PK(42), Uint8Array.of(1), u64le(123_456_789n), Uint8Array.of(255))

      // ACT
      const dep = parseMemberDeposit(data)

      // ASSERT
      expect(dep.member).toBe(encodeBase58(PK(42)))
      expect(dep.strategyIndex).toBe(1)
      expect(dep.pending).toBe(123_456_789n)
    })
  })
})

describe('issueSharesIx', () => {
  describe('expected behavior', () => {
    it('should encode the anchor discriminator, amount and account order', async () => {
      // ARRANGE
      expect.assertions(5)
      const member = encodeBase58(PK(42)) as never
      const deposit = { member, pending: 200_000_000n, strategyIndex: 0 }
      const depositPda = encodeBase58(PK(77)) as never
      const strategy = { shareMint: encodeBase58(PK(15)) } as never

      // ACT
      const ix = await issueSharesIx(
        encodeBase58(PK(2)) as never,
        deposit,
        depositPda,
        strategy,
        200_000_000n,
        'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' as never,
      )

      // ASSERT — caller, state, vault, memberDeposit, source, destination, token
      expect(ix.accounts?.length).toBe(7)
      expect(ix.accounts?.[0]?.role).toBe(3) // READONLY_SIGNER
      expect(ix.accounts?.[3]?.address).toBe(depositPda)
      expect(ix.data?.length).toBe(16) // disc(8) + u64
      expect(Array.from(ix.data?.slice(8) ?? [])).toEqual(Array.from(u64le(200_000_000n)))
    })
  })

  describe('unexpected behavior', () => {
    beforeEach(() => {
      vi.spyOn(console, 'log').mockImplementation(() => {})
    })
    afterEach(() => {
      vi.restoreAllMocks()
    })

    it('should reject a malformed member address', async () => {
      // ARRANGE
      expect.assertions(1)
      const deposit = { member: '!!!not-base58!!!', pending: 1n, strategyIndex: 0 }

      // ACT & ASSERT
      await expect(
        issueSharesIx(
          encodeBase58(PK(2)) as never,
          deposit as never,
          'x' as never,
          { shareMint: 'y' } as never,
          1n,
          'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' as never,
        ),
      ).rejects.toThrow()
    })
  })
})

describe('vaultAta', () => {
  describe('expected behavior', () => {
    it('should derive a deterministic ATA for the vault PDA', async () => {
      // ARRANGE
      expect.assertions(2)
      const mint = encodeBase58(PK(15)) as never

      // ACT
      const a = await vaultAta(mint, 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' as never)
      const b = await vaultAta(mint, 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' as never)

      // ASSERT
      expect(a).toBe(b)
      expect(a).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/)
    })
  })
})
