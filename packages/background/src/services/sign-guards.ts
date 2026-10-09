import { getTransactionDecoder } from '@solana/kit'

// The API's canonical request signature (packages/feature-fims fims-api.ts)
// is produced by signing "fims-wallet-v3\n{host}\n{method}..." with the
// wallet key. If a website could obtain that exact signature through
// signMessage, it would hold a 5-minute write session on the member's API
// account — a textbook cross-protocol phishing attack. The prefix is
// refused outright.
const FORBIDDEN_MESSAGE_PREFIXES = ['fims-wallet-v3\n']

// ed25519 signs raw bytes: a "message" that is actually a serialized Solana
// transaction produces a signature the network will happily execute. This
// is THE blind-signing drain vector — refuse anything that decodes.
export function isLikelyTransaction(bytes: Uint8Array): boolean {
  try {
    const decoded = getTransactionDecoder().decode(bytes)
    return decoded.messageBytes.length > 0
  } catch {
    return false
  }
}

export function assertMessageSignable(message: Uint8Array): void {
  for (const prefix of FORBIDDEN_MESSAGE_PREFIXES) {
    const bytes = new TextEncoder().encode(prefix)
    if (message.length >= bytes.length && bytes.every((byte, i) => message[i] === byte)) {
      throw new Error('refusing to sign a wallet-API authentication message')
    }
  }
  if (isLikelyTransaction(message)) {
    throw new Error('refusing to sign a transaction as a message')
  }
}
