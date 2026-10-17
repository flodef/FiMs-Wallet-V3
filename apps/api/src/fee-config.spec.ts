import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { getFimsFeeRate } from './fee-config.ts'

// The operating fee is configured in TWO deployables that cannot share a
// module (the API is a standalone function) — and is stated on the public
// landing page. This spec is the single check that all three copies tell
// the same story; the client copy is read as text because its package is
// outside this project's rootDir.
const clientConfig = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), '../../../packages/feature-fims/src/fims-fee-config.ts'),
  'utf-8',
)
const landing = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), '../../web/src/landing/landing.html'),
  'utf-8',
)

describe('fee-config parity', () => {
  describe('expected behavior', () => {
    it('should use the same operating fee rate in the API and the app', () => {
      // ARRANGE
      expect.assertions(1)
      const clientRate = Number(clientConfig.match(/fimsFeeRate:\s*([0-9.]+)/)?.[1])

      // ACT & ASSERT
      expect(getFimsFeeRate()).toBe(clientRate)
    })

    it('should state the same fee on the public landing page FAQ', () => {
      // ARRANGE
      expect.assertions(1)
      const frenchRate = `${(getFimsFeeRate() * 100).toString().replace('.', ',')} %`

      // ACT & ASSERT
      expect(landing).toContain(frenchRate)
    })
  })
})
