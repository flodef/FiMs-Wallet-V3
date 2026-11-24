// cspell:ignore Cumul
// @vitest-environment node
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Db } from './db/service.js'
import { memberCirculation, monthStart, netInvested, summarizeMember } from './member-stats.js'

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

// memberCirculation runs one aggregate SQL pass — the semantics live in the
// query, so the spec drives it against a real (in-process) Postgres via
// pglite rather than a mocked db.execute.
describe('memberCirculation', () => {
  let pg: PGlite
  let db: Db

  beforeAll(async () => {
    pg = new PGlite()
    await pg.exec(`
      CREATE TABLE users (id serial PRIMARY KEY, name text NOT NULL);
      CREATE TABLE transactions (
        id serial PRIMARY KEY,
        user_id integer REFERENCES users(id),
        type text,
        token text,
        amount numeric,
        donation_amount numeric,
        donation_target text
      );
    `)
    db = drizzle(pg) as unknown as Db
  })

  beforeEach(async () => {
    await pg.exec('TRUNCATE transactions, users RESTART IDENTITY')
  })

  afterAll(async () => {
    await pg.close()
  })

  const seedUsers = () => pg.exec(`INSERT INTO users (name) VALUES ('Alice'), ('Flodef'), ('Tontine'), ('Bob')`)

  // tx helper: (userNameIdx, type, token, amount, donationAmount, donationTarget)
  // user ids are serial: Alice=1, Flodef=2, Tontine=3, Bob=4
  const tx = (
    userId: number,
    type: string,
    token: string,
    amount: string | null,
    da: string | null,
    dt: string | null,
  ) =>
    pg.query(
      'INSERT INTO transactions (user_id, type, token, amount, donation_amount, donation_target) VALUES ($1,$2,$3,$4,$5,$6)',
      [userId, type, token, amount, da, dt],
    )

  describe('expected behavior', () => {
    it('should exclude Flodef, the Tontine user and donation rows from members', async () => {
      // ARRANGE
      expect.assertions(3)
      await seedUsers()
      await tx(1, 'deposit', 'FSOL', '10', null, null) // Alice member units +10
      await tx(1, 'withdrawal', 'FSOL', '-4', '1', 'tontine') // members −5, tontine +1
      await tx(1, 'donation', 'FSOL', '22', null, 'tontine') // members excluded, tontine +22
      await tx(2, 'deposit', 'FSOL', '100', null, null) // Flodef — excluded
      await tx(3, 'deposit', 'FSOL', '50', null, null) // Tontine user — excluded from members
      await tx(4, 'withdrawal', 'FSOL', '-3', null, null) // Bob member units −3
      await tx(1, 'withdrawal', 'FiMs', '-2', null, 'association') // other token, non-tontine target

      // ACT
      const result = await memberCirculation(db)

      // ASSERT — members = 10 − 5 − 3 = 2; tontine = 1 + 22 = 23
      expect(result.FSOL).toEqual({ members: 2, tontine: 23, total: 25 })
      expect(result.FiMs).toEqual({ members: -2, tontine: 0, total: -2 })
      expect(result.FLiP).toEqual({ members: 0, tontine: 0, total: 0 }) // missing token → zeros
    })

    it('should count tontine-targeted rows regardless of the owning user', async () => {
      // ARRANGE
      expect.assertions(1)
      await seedUsers()
      await tx(3, 'donation', 'FLiP', '7', null, 'tontine') // Tontine user's own gift row
      await tx(1, 'deposit', 'FLiP', '4', null, null)

      // ACT
      const result = await memberCirculation(db)

      // ASSERT — members = 4 (Alice only); tontine = 7 (user-agnostic invariant)
      expect(result.FLiP).toEqual({ members: 4, tontine: 7, total: 11 })
    })

    it('should return an ISO computedAt timestamp', async () => {
      // ARRANGE
      expect.assertions(2)
      await seedUsers()

      // ACT
      const result = await memberCirculation(db)

      // ASSERT
      expect(Number.isNaN(Date.parse(result.computedAt))).toBe(false)
      expect(result.computedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    })
  })

  describe('unexpected behavior', () => {
    beforeEach(() => {
      vi.spyOn(console, 'log').mockImplementation(() => {})
    })

    afterEach(() => {
      vi.restoreAllMocks()
    })

    it('should reject when the database query fails', async () => {
      // ARRANGE
      expect.assertions(1)
      const brokenDb = {
        execute: () => Promise.reject(new Error('db down')),
      } as unknown as Db

      // ACT & ASSERT
      await expect(memberCirculation(brokenDb)).rejects.toThrow('db down')
    })
  })
})
