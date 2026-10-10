import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { fimsSessionMessage } from './services/auth/service.js'

// The API auth message formats are built in TWO places: the server
// (service.ts / helpers.ts) verifies signatures over messages the client
// (feature-fims/fims-api.ts) constructs byte-identically. A drift in either
// copy silently breaks login — or worse, makes a signature valid on one side
// but not the other (audit L-11). This spec diffs the literal fragments.
const CLIENT_API = readFileSync(join(import.meta.dirname, '../../../packages/feature-fims/src/fims-api.ts'), 'utf-8')
const SERVER_AUTH = readFileSync(join(import.meta.dirname, 'services/auth/service.ts'), 'utf-8')
const SERVER_HELPERS = readFileSync(join(import.meta.dirname, 'routes/fims/helpers.ts'), 'utf-8')

// Fragments contain real newlines in the built message but `\n` escapes in
// source template literals — compare in the escaped form.
const escaped = (text: string) => text.replace(/\n/g, '\\n')
const interpolate = (name: string) => '${' + name + '}'

describe('fims-messages', () => {
  describe('expected behavior', () => {
    it('should keep the SIWS session message byte-identical between client and server', () => {
      // ARRANGE
      expect.assertions(6)
      const built = fimsSessionMessage('HOST', 'ADDR', 'NONCE', 'ISSUED')
      // Compare per LINE — the client builder concatenates several string
      // literals, so multi-line fragments are not contiguous in source but
      // every literal line-fragment is.
      const literals = built
        .split('\n')
        .flatMap((line) => line.split(/HOST|ADDR|NONCE|ISSUED/))
        .filter((part) => part.trim().length > 0)

      // ACT
      const missing = literals.filter((part) => !CLIENT_API.includes(escaped(part)))

      // ASSERT
      expect(literals.length).toBeGreaterThan(3)
      expect(missing).toEqual([])
      // And the four placeholders must be interpolated in the same order —
      // a swapped Nonce/Issued-At is a real signature-mismatch bug.
      const clientFn = CLIENT_API.match(/function fimsSessionMessage[\s\S]*?return \(([\s\S]*?)\)\n}/)?.[1] ?? ''
      for (const field of [
        `URI: ${interpolate('host')}`,
        `Nonce: ${interpolate('nonce')}`,
        `Issued At: ${interpolate('issuedAt')}`,
      ]) {
        expect(clientFn).toContain(field)
      }
      expect(clientFn.indexOf('Nonce')).toBeLessThan(clientFn.indexOf('Issued At'))
    })

    it('should keep the auth protocol prefixes identical on both sides', () => {
      // ARRANGE
      expect.assertions(3)

      // ACT & ASSERT — every protocol-tagged family must appear in the
      // client source exactly as the server verifies it.
      expect(CLIENT_API).toContain('fims-wallet-v3\\n')
      expect(CLIENT_API).toContain('fims-confirm\\n')
      // The link-address consent message shares the request prefix.
      expect(SERVER_HELPERS).toContain('fims-wallet-v3\\nlink-address')
    })

    it('should keep the link-address message shape identical on both sides', () => {
      // ARRANGE
      expect.assertions(2)

      // ACT & ASSERT
      const linkShape = 'fims-wallet-v3\\nlink-address\\n' + interpolate('userId') + '\\n' + interpolate('address')
      expect(CLIENT_API).toContain(linkShape)
      expect(SERVER_AUTH + SERVER_HELPERS).toContain(linkShape)
    })
  })
})
