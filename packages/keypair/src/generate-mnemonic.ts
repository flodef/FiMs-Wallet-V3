import * as bip39 from '@scure/bip39'

import { getMnemonicWordlist, type MnemonicLanguage } from './get-mnemonic-wordlist.ts'

export const MnemonicStrength = [128, 256] as const

export type MnemonicStrength = (typeof MnemonicStrength)[number]

export function generateMnemonic({
  language = 'en',
  strength = 128,
}: {
  language?: MnemonicLanguage
  strength?: MnemonicStrength
} = {}): string {
  if (![128, 256].includes(strength)) {
    throw new Error('strength must be 128 or 256')
  }
  const wordlist = getMnemonicWordlist(language)

  return bip39.generateMnemonic(wordlist, strength)
}
