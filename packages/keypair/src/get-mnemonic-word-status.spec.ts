/* cspell:ignore aban fdsfds */
import { describe, expect, it } from 'vitest'

import { getMnemonicWordStatus } from './get-mnemonic-word-status.ts'

describe('get-mnemonic-word-status', () => {
  describe('expected behavior', () => {
    it('should return valid for a complete wordlist word', () => {
      // ARRANGE
      const word = 'abandon'

      // ACT
      const result = getMnemonicWordStatus(word)

      // ASSERT
      expect(result).toBe('valid')
    })

    it('should return partial for a prefix of a wordlist word', () => {
      // ARRANGE
      const word = 'aban'

      // ACT
      const result = getMnemonicWordStatus(word)

      // ASSERT
      expect(result).toBe('partial')
    })
  })

  describe('unexpected behavior', () => {
    it('should return empty for an empty string', () => {
      // ARRANGE
      const word = ''

      // ACT
      const result = getMnemonicWordStatus(word)

      // ASSERT
      expect(result).toBe('empty')
    })

    it('should return invalid for a word that is not a wordlist prefix', () => {
      // ARRANGE
      const word = 'fdsfds'

      // ACT
      const result = getMnemonicWordStatus(word)

      // ASSERT
      expect(result).toBe('invalid')
    })

    it('should return invalid for a word extending beyond a wordlist word', () => {
      // ARRANGE
      const word = 'abandoned'

      // ACT
      const result = getMnemonicWordStatus(word)

      // ASSERT
      expect(result).toBe('invalid')
    })
  })
})
