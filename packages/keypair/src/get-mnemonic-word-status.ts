import { getMnemonicWordlist } from './get-mnemonic-wordlist.ts'

export type MnemonicWordStatus = 'empty' | 'invalid' | 'partial' | 'valid'

export function getMnemonicWordStatus(word: string): MnemonicWordStatus {
  if (!word.length) {
    return 'empty'
  }
  const wordlist = getMnemonicWordlist()
  if (wordlist.includes(word)) {
    return 'valid'
  }
  return wordlist.some((entry) => entry.startsWith(word)) ? 'partial' : 'invalid'
}
