import { describe, expect, it } from 'vitest'
import { ballotChangeRetryAt } from './vote-ballot-rules.js'

const HOUR = 60 * 60 * 1000

describe('vote-ballot-rules', () => {
  describe('expected behavior', () => {
    it('should allow the first ballot freely', () => {
      // ARRANGE
      expect.assertions(1)

      // ACT
      const result = ballotChangeRetryAt(null, 7)

      // ASSERT
      expect(result).toBeNull()
    })

    it('should allow re-selecting the same option at any time', () => {
      // ARRANGE
      expect.assertions(1)
      const existing = { optionId: 7, updatedAt: new Date(Date.now() - 60 * 1000) }

      // ACT
      const result = ballotChangeRetryAt(existing, 7)

      // ASSERT
      expect(result).toBeNull()
    })

    it('should allow a change after 24 h', () => {
      // ARRANGE
      expect.assertions(1)
      const existing = { optionId: 7, updatedAt: new Date(Date.now() - 25 * HOUR) }

      // ACT
      const result = ballotChangeRetryAt(existing, 9)

      // ASSERT
      expect(result).toBeNull()
    })
  })

  describe('unexpected behavior', () => {
    it('should reject a second change inside 24 h and give the retry time', () => {
      // ARRANGE
      expect.assertions(2)
      const now = Date.now()
      const existing = { optionId: 7, updatedAt: new Date(now - 2 * HOUR) }

      // ACT
      const result = ballotChangeRetryAt(existing, 9, now)

      // ASSERT
      expect(result).not.toBeNull()
      expect(result?.getTime()).toBe(existing.updatedAt.getTime() + 24 * HOUR)
    })
  })
})
