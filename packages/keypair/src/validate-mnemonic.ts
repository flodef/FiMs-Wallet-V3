import * as bip39 from '@scure/bip39'

import { getMnemonicWordlists } from './get-mnemonic-wordlist.ts'

export function validateMnemonic({ mnemonic }: { mnemonic: string }) {
  // The wordlist is auto-detected: a French phrase validates against the
  // French list, English against the English one, etc.
  const valid = getMnemonicWordlists().some((wordlist) => bip39.validateMnemonic(mnemonic, wordlist))
  if (!valid) {
    throw new Error('Invalid mnemonic')
  }
  return mnemonic
}
