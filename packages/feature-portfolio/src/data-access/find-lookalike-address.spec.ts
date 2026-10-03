import { describe, expect, it } from 'vitest'

import { findLookalikeAddress } from './find-lookalike-address.ts'

describe('find-lookalike-address', () => {
  const known = '5F86TNSTre3CYwZd1wELsGQGhqG2HkN3d8zxhbyBSnzm'

  describe('expected behavior', () => {
    it('should return null when the destination is an exact match', async () => {
      // ARRANGE
      expect.assertions(1)

      // ACT
      const result = findLookalikeAddress({ destination: known, knownAddresses: [known] })

      // ASSERT
      expect(result).toBeNull()
    })

    it('should return null when the destination is unrelated to all known addresses', async () => {
      // ARRANGE
      expect.assertions(1)
      const destination = '9yotBGPUC8J1h4sU2vQKxYpN3mZdRaWfEtVcGhJkLmNo'

      // ACT
      const result = findLookalikeAddress({ destination, knownAddresses: [known] })

      // ASSERT
      expect(result).toBeNull()
    })

    it('should flag a destination that shares the first and last four characters with a known address', async () => {
      // ARRANGE
      expect.assertions(1)
      const poisoned = `5F86XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXSnzm`

      // ACT
      const result = findLookalikeAddress({ destination: poisoned, knownAddresses: [known] })

      // ASSERT
      expect(result).toBe(known)
    })

    it('should return null when no known addresses exist', async () => {
      // ARRANGE
      expect.assertions(1)

      // ACT
      const result = findLookalikeAddress({ destination: known, knownAddresses: [] })

      // ASSERT
      expect(result).toBeNull()
    })
  })
})
