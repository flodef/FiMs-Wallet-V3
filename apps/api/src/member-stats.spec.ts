// cspell:ignore Cumul
import { describe, expect, it } from 'vitest'
import { monthStart, netInvested, summarizeMember } from './member-stats.js'

const NOW = new Date('2026-10-27T12:00:00Z')

const row = (over: Partial<Parameters<typeof summarizeMember>[0][number]>) => ({
  amount: null,
  cost: 0,
  date: new Date('2024-01-15T00:00:00Z'),
  donationAmount: null,
  donationTarget: null,
  movement: 0,
  token: null,
  type: 'deposit',
  ...over,
})

describe('monthStart', () => {
  describe('expected behavior', () => {
    it('should return the UTC first-of-month containing the date', () => {
      // ARRANGE
      expect.assertions(1)
      const input = new Date('2026-10-27T12:00:00Z')

      // ACT
      const result = monthStart(input)

      // ASSERT
      expect(result.toISOString()).toBe('2026-10-01T00:00:00.000Z')
    })
  })
})

describe('netInvested', () => {
  describe('expected behavior', () => {
    it('should subtract the absolute fee from the movement', () => {
      // ARRANGE
      expect.assertions(1)
      const input = { cost: -0.18, movement: -90.62 }

      // ACT
      const result = netInvested(input)

      // ASSERT
      expect(result).toBeCloseTo(-90.8)
    })
  })
})

describe('summarizeMember', () => {
  describe('expected behavior', () => {
    it('should compute invested as movement minus absolute cost across rows', () => {
      // ARRANGE
      expect.assertions(2)
      const input = [
        row({ date: new Date('2024-01-15T00:00:00Z'), movement: 100 }),
        row({ cost: -0.18, date: new Date('2024-02-10T00:00:00Z'), movement: -90.62, type: 'withdrawal' }),
        // Donation pair: withdrawal of units + gift row — invested-neutral.
        row({ amount: '-22', date: new Date('2024-03-01T00:00:00Z'), token: 'FSOL', type: 'withdrawal' }),
        row({
          amount: '22',
          cost: 2376.65,
          date: new Date('2024-03-01T00:00:00Z'),
          donationTarget: 'tontine',
          movement: 2376.65,
          token: 'FSOL',
          type: 'donation',
        }),
      ]

      // ACT
      const result = summarizeMember(input, new Map(), NOW)

      // ASSERT
      expect(result.invested).toBeCloseTo(9.2)
      expect(result.donated).toBeCloseTo(2376.65)
    })

    it('should exclude donation rows from member units and subtract embedded gifts', () => {
      // ARRANGE
      expect.assertions(2)
      const input = [
        row({ amount: '10', date: new Date('2024-01-15T00:00:00Z'), movement: 100, token: 'FSOL' }),
        row({ amount: '-22', date: new Date('2024-02-01T00:00:00Z'), token: 'FSOL', type: 'withdrawal' }),
        row({
          amount: '22',
          cost: 100,
          date: new Date('2024-02-01T00:00:00Z'),
          movement: 100,
          token: 'FSOL',
          type: 'donation',
        }),
        row({
          amount: '-30',
          date: new Date('2024-03-01T00:00:00Z'),
          donationAmount: '2.52',
          donationTarget: 'tontine',
          movement: -60,
          token: 'FSOL',
          type: 'withdrawal',
        }),
      ]

      // ACT
      const result = summarizeMember(input, new Map([['FSOL', 100]]), NOW)

      // ASSERT
      expect(result.positions.find((p) => p.symbol === 'FSOL')?.units).toBeCloseTo(-44.52)
      expect(result.positions.find((p) => p.symbol === 'FSOL')?.value).toBeCloseTo(-4452)
    })

    it('should derive profit, gross ratio and yearly rate like the spreadsheet', () => {
      // ARRANGE
      expect.assertions(4)
      // One deposit a year ago, position doubled: profit = invested.
      const input = [row({ amount: '10', date: new Date('2025-10-27T00:00:00Z'), movement: 1000, token: 'FSOL' })]

      // ACT
      const result = summarizeMember(input, new Map([['FSOL', 200]]), NOW)

      // ASSERT
      expect(result.total).toBeCloseTo(2000)
      expect(result.profit).toBeCloseTo(1000)
      expect(result.profitRatio).toBeCloseTo(1)
      // Cumul is 0 for 12 months then 1000: mean ≈ invested/13 → rate ≈ 13.
      expect(result.yearlyRate).not.toBeNull()
    })

    it('should count embedded gift value toward donated', () => {
      // ARRANGE
      expect.assertions(1)
      const input = [
        row({
          amount: '-30',
          cost: 0,
          date: new Date('2024-01-15T00:00:00Z'),
          donationAmount: '3',
          donationTarget: 'tontine',
          movement: -90,
          token: 'FSOL',
          type: 'withdrawal',
        }),
      ]

      // ACT
      const result = summarizeMember(input, new Map(), NOW)

      // ASSERT
      // Implied rate: |movement + cost| / |amount| = 3 → gift = 3 × 3 = 9.
      expect(result.donated).toBeCloseTo(9)
    })
  })

  describe('unexpected behavior', () => {
    it('should return an empty summary when the member has no rows', () => {
      // ARRANGE
      expect.assertions(3)

      // ACT
      const result = summarizeMember([], new Map(), NOW)

      // ASSERT
      expect(result.invested).toBe(0)
      expect(result.yearlyRate).toBeNull()
      expect(result.durationDays).toBeNull()
    })
  })
})
