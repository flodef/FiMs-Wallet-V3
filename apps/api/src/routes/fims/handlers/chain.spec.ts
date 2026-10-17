import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Db } from '../../../db/service.js'
import { FIMS_TONTINE_ADDRESS } from '../../../fims-constants.js'
import { chainTargetAllowed } from './chain.js'

// The SQL CTE itself stays DB-bound; this spec pins the decision logic
// around it — which flags grant access, and that member privacy can never
// be opened through the address-book clause.

const dbWith = (row: { in_book: boolean; own: boolean; public_member: boolean } | undefined) =>
  ({
    execute: vi.fn(async () => ({ rows: row ? [row] : [] })),
  }) as unknown as Db

describe('chainTargetAllowed', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  describe('expected behavior', () => {
    it('should allow an admin signer without touching the database', async () => {
      // ARRANGE
      expect.assertions(2)
      vi.stubEnv('ADMIN_ADDRESSES', 'admin-signer')
      const db = dbWith(undefined)

      // ACT
      const result = await chainTargetAllowed(db, 'admin-signer', 'any-target')

      // ASSERT
      expect(result).toBe(true)
      expect(db.execute).not.toHaveBeenCalled()
    })

    it('should allow protocol addresses and self-reads without touching the database', async () => {
      // ARRANGE
      expect.assertions(3)
      const db = dbWith(undefined)

      // ACT
      const resultTontine = await chainTargetAllowed(db, 'member-signer', FIMS_TONTINE_ADDRESS)
      const resultSelf = await chainTargetAllowed(db, 'member-signer', 'member-signer')

      // ASSERT
      expect(resultTontine).toBe(true)
      expect(resultSelf).toBe(true)
      expect(db.execute).not.toHaveBeenCalled()
    })

    it('should allow a target linked to the signer own member', async () => {
      // ARRANGE
      expect.assertions(1)
      const db = dbWith({ in_book: false, own: true, public_member: false })

      // ACT
      const result = await chainTargetAllowed(db, 'member-signer', 'own-alias')

      // ASSERT
      expect(result).toBe(true)
    })

    it('should allow a target belonging to a public member', async () => {
      // ARRANGE
      expect.assertions(1)
      const db = dbWith({ in_book: false, own: false, public_member: true })

      // ACT
      const result = await chainTargetAllowed(db, 'member-signer', 'public-member-address')

      // ASSERT
      expect(result).toBe(true)
    })

    it('should allow a non-member target in the signer address book', async () => {
      // ARRANGE
      expect.assertions(1)
      const db = dbWith({ in_book: true, own: false, public_member: false })

      // ACT
      const result = await chainTargetAllowed(db, 'member-signer', 'booked-cex-address')

      // ASSERT
      expect(result).toBe(true)
    })
  })

  describe('unexpected behavior', () => {
    beforeEach(() => {
      vi.spyOn(console, 'log').mockImplementation(() => {})
    })

    afterEach(() => {
      vi.restoreAllMocks()
    })

    it('should deny an arbitrary address no clause covers', async () => {
      // ARRANGE
      expect.assertions(1)
      const db = dbWith({ in_book: false, own: false, public_member: false })

      // ACT
      const result = await chainTargetAllowed(db, 'member-signer', 'random-address')

      // ASSERT
      expect(result).toBe(false)
    })

    it('should deny when the query returns no row', async () => {
      // ARRANGE
      expect.assertions(1)
      const db = dbWith(undefined)

      // ACT
      const result = await chainTargetAllowed(db, 'member-signer', 'random-address')

      // ASSERT
      expect(result).toBe(false)
    })
  })
})
