import { wordlist as english } from '@scure/bip39/wordlists/english.js'
import { wordlist as french } from '@scure/bip39/wordlists/french.js'

export const MnemonicLanguage = ['en', 'fr'] as const

export type MnemonicLanguage = (typeof MnemonicLanguage)[number]

const wordlists: Record<MnemonicLanguage, string[]> = { en: english, fr: french }

export function getMnemonicWordlist(language: MnemonicLanguage = 'en'): string[] {
  return wordlists[language]
}

// All supported lists: an imported mnemonic may be in any of them.
export function getMnemonicWordlists(): string[][] {
  return MnemonicLanguage.map((language) => wordlists[language])
}
