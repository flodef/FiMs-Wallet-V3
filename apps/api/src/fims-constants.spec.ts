import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { FIMS_DEMO_ADDRESS, FIMS_TONTINE_ADDRESS, FIMS_TREASURY_ADDRESS } from './fims-constants.js'

// The API is a standalone Vercel bundle on purpose, so FiMs protocol
// addresses live in two copies (client + API). This test is the contract
// that keeps them identical: it reads the client source and compares the
// literals — a drifted copy fails loudly instead of silently dropping
// tontine reconciliation or mislabelling the treasury.
const CLIENT_CONSTANTS = readFileSync(
  join(import.meta.dirname, '../../../packages/feature-fims/src/fims-constants.ts'),
  'utf-8',
)

describe('fims-constants', () => {
  describe('expected behavior', () => {
    it('should match the client copy of protocol addresses', () => {
      // ARRANGE
      expect.assertions(3)
      const extract = (name: string) => {
        const match = CLIENT_CONSTANTS.match(new RegExp(`${name} = '([^']+)'`))
        if (!match) throw new Error(`${name} not found in client fims-constants.ts`)
        return match[1]
      }

      // ACT
      const clientTreasury = extract('FIMS_TREASURY_ADDRESS')
      const clientTontine = extract('FIMS_TONTINE_ADDRESS')
      const clientDemo = extract('FIMS_DEMO_ADDRESS')

      // ASSERT
      expect(FIMS_TREASURY_ADDRESS).toBe(clientTreasury)
      expect(FIMS_TONTINE_ADDRESS).toBe(clientTontine)
      expect(FIMS_DEMO_ADDRESS).toBe(clientDemo)
    })
  })
})
