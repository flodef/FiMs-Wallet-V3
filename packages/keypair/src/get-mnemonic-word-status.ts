import { getMnemonicWordlists } from './get-mnemonic-wordlist.ts'

export type MnemonicWordStatus = 'empty' | 'invalid' | 'partial' | 'valid'

export function getMnemonicWordStatus(word: string): MnemonicWordStatus {
  if (!word.length) {
    return 'empty'
  }
  const wordlists = getMnemonicWordlists()
  if (wordlists.some((wordlist) => wordlist.includes(word))) {
    return 'valid'
  }
  return wordlists.some((wordlist) => wordlist.some((entry) => entry.startsWith(word))) ? 'partial' : 'invalid'
}
