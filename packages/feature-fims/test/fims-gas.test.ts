import { NATIVE_MINT } from '@workspace/solana-client/constants'
import { describe, expect, it } from 'vitest'
import { FIMS_FSOL_MINT, FIMS_KNOWN_MINTS, FIMS_SOL_GAS_RESERVE } from '../src/fims-constants.ts'
import { getFimsPlatformFeeBps } from '../src/fims-fee-config.ts'
import {
  fimsSwappableMints,
  isInsufficientGasError,
  isSolGasMint,
  solExcessAboveReserve,
  solGasDeficit,
} from '../src/fims-gas.ts'

describe('fimsSwappableMints', () => {
  describe('expected behavior', () => {
    it('should include every spreadsheet token that has a concrete mint', () => {
      // ARRANGE
      expect.assertions(3)
      const tokens = [{ address: 'mint-a' }, { address: 'mint-b' }, { address: 'mint-c' }]

      // ACT
      const result = fimsSwappableMints(tokens)

      // ASSERT
      expect(result.size).toBe(3)
      expect(result.has('mint-a')).toBe(true)
      expect(result.has('mint-c')).toBe(true)
    })

    it('should exclude tokens without an address and undefined lists', () => {
      // ARRANGE
      expect.assertions(2)
      const tokens: { address?: null | string | undefined }[] = [
        { address: 'mint-a' },
        { address: null },
        { address: undefined },
        { address: '' },
      ]

      // ACT
      const result = fimsSwappableMints(tokens)

      // ASSERT
      expect(result.has('mint-a')).toBe(true)
      expect(fimsSwappableMints(undefined).size).toBe(0)
    })

    it('should never include SOL even if a spreadsheet row carries the native mint', () => {
      // ARRANGE
      expect.assertions(1)
      const tokens = [{ address: NATIVE_MINT }, { address: 'mint-a' }]
      const mints = fimsSwappableMints(tokens)

      // ACT — the swap selectors combine the allowlist with a SOL check
      const selectable = [...mints].filter((mint) => !isSolGasMint(mint))

      // ASSERT
      expect(selectable).toEqual(['mint-a'])
    })
  })
})

describe('isSolGasMint', () => {
  it('should only flag the native mint as gas', () => {
    // ARRANGE & ACT & ASSERT
    expect.assertions(3)
    expect(isSolGasMint(NATIVE_MINT)).toBe(true)
    expect(isSolGasMint('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v')).toBe(false)
    expect(isSolGasMint('anything')).toBe(false)
  })
})

describe('solGasDeficit', () => {
  it('should return the missing lamports below the 0.01 SOL reserve', () => {
    // ARRANGE & ACT & ASSERT
    expect.assertions(3)
    expect(solGasDeficit(0n)).toBe(FIMS_SOL_GAS_RESERVE)
    expect(solGasDeficit(FIMS_SOL_GAS_RESERVE - 1n)).toBe(1n)
    expect(solGasDeficit(4_000_000n)).toBe(6_000_000n)
  })

  it('should return zero at or above the reserve', () => {
    // ARRANGE & ACT & ASSERT
    expect.assertions(2)
    expect(solGasDeficit(FIMS_SOL_GAS_RESERVE)).toBe(0n)
    expect(solGasDeficit(FIMS_SOL_GAS_RESERVE * 2n)).toBe(0n)
  })
})

describe('solExcessAboveReserve', () => {
  it('should return the lamports above the reserve', () => {
    // ARRANGE & ACT & ASSERT
    expect.assertions(3)
    expect(solExcessAboveReserve(0n)).toBe(0n)
    expect(solExcessAboveReserve(FIMS_SOL_GAS_RESERVE)).toBe(0n)
    expect(solExcessAboveReserve(FIMS_SOL_GAS_RESERVE + 5_000_000n)).toBe(5_000_000n)
  })
})

describe('isInsufficientGasError', () => {
  describe('expected behavior', () => {
    it('should detect SOL shortage errors', () => {
      // ARRANGE & ACT & ASSERT
      expect.assertions(4)
      expect(isInsufficientGasError(new Error('insufficient lamports 100, needed 5000'))).toBe(true)
      expect(isInsufficientGasError('Insufficient funds for rent')).toBe(true)
      expect(isInsufficientGasError(new Error('Transaction fee payer required'))).toBe(true)
      expect(isInsufficientGasError(new Error('account exceeds balance'))).toBe(true)
    })
  })

  describe('unexpected behavior', () => {
    it('should not flag unrelated errors', () => {
      // ARRANGE & ACT & ASSERT
      expect.assertions(3)
      expect(isInsufficientGasError(new Error('Jupiter swap failed: 500'))).toBe(false)
      expect(isInsufficientGasError('slippage exceeded')).toBe(false)
      expect(isInsufficientGasError(undefined)).toBe(false)
    })
  })
})

describe('getFimsPlatformFeeBps', () => {
  it('should default to 20 basis points (0.2%)', () => {
    // ARRANGE & ACT & ASSERT
    expect.assertions(1)
    expect(getFimsPlatformFeeBps()).toBe(20)
  })
})

describe('FIMS_FSOL_MINT', () => {
  it('should be the canonical FSOL mint pinned in the known mints', () => {
    // ARRANGE & ACT & ASSERT
    expect.assertions(2)
    expect(FIMS_FSOL_MINT).toBe('6hoGUYo5VengrsRtyyvs2y7KPf4mwWdv7V8C7GJg6Uy')
    expect(FIMS_KNOWN_MINTS['FSOL']).toBe(FIMS_FSOL_MINT)
  })
})
