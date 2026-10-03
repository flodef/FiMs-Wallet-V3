import { wordlist as english } from '@scure/bip39/wordlists/english.js'
import { wordlist as french } from '@scure/bip39/wordlists/french.js'
import { wordlist as spanish } from '@scure/bip39/wordlists/spanish.js'

export const MnemonicLanguage = ['en', 'fr', 'es'] as const

export type MnemonicLanguage = (typeof MnemonicLanguage)[number]

const wordlists: Record<MnemonicLanguage, string[]> = { en: english, es: spanish, fr: french }

export function getMnemonicWordlist(language: MnemonicLanguage = 'en'): string[] {
  return wordlists[language]
}

// All supported lists: an imported mnemonic may be in any of them.
export function getMnemonicWordlists(): string[][] {
  return MnemonicLanguage.map((language) => wordlists[language])
}

// Default mnemonic language matching the app UI language (i18next code like
// "fr", "fr-FR", "es-419"), falling back to English.
export function mnemonicLanguageFromAppLanguage(appLanguage: string | undefined): MnemonicLanguage {
  const prefix = appLanguage?.slice(0, 2).toLowerCase()
  return MnemonicLanguage.find((language) => language === prefix) ?? 'en'
}
