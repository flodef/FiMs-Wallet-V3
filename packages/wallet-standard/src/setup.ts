import { registerWallet } from '@wallet-standard/core'

import { FimsWallet } from './wallet.ts'

export function setup() {
  registerWallet(new FimsWallet())
}
