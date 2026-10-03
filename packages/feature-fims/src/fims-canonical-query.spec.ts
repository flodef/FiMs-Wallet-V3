import { describe, expect, it } from 'vitest'

import { canonicalizeQuery, canonicalResource } from './fims-canonical-query.ts'

// These cases must match the server-side algorithm in
// apps/api/src/services/auth/service.ts — a mismatch makes every signed
// request with a query string fail verification.
describe('canonicalize-query', () => {
  describe('expected behavior', () => {
    it('should serialize an empty query to an empty string', () => {
      // ARRANGE
      expect.assertions(1)
      const params = new URLSearchParams('')

      // ACT
      const result = canonicalizeQuery(params)

      // ASSERT
      expect(result).toBe('')
    })

    it('should sort pairs by key then value', () => {
      // ARRANGE
      expect.assertions(1)
      const params = new URLSearchParams('b=2&a=1&a=0')

      // ACT
      const result = canonicalizeQuery(params)

      // ASSERT
      expect(result).toBe('a=0&a=1&b=2')
    })

    it('should produce the same canonical form for reordered input', () => {
      // ARRANGE
      expect.assertions(1)

      // ACT
      const result = canonicalizeQuery(new URLSearchParams('offset=0&limit=2000'))
      const result2 = canonicalizeQuery(new URLSearchParams('limit=2000&offset=0'))

      // ASSERT
      expect(result).toBe(result2)
    })
  })
})

describe('canonical-resource', () => {
  describe('expected behavior', () => {
    it('should return the bare path when there is no query', () => {
      // ARRANGE
      expect.assertions(1)

      // ACT
      const result = canonicalResource('/fims/votes', new URLSearchParams(''))

      // ASSERT
      expect(result).toBe('/fims/votes')
    })

    it('should append the canonical query to the path', () => {
      // ARRANGE
      expect.assertions(1)

      // ACT
      const result = canonicalResource('/fims/users', new URLSearchParams('offset=0&limit=2000'))

      // ASSERT
      expect(result).toBe('/fims/users?limit=2000&offset=0')
    })
  })
})
