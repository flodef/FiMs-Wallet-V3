import { getTransactionDecoder } from '@solana/kit'

// The API's canonical request signatures (packages/feature-fims fims-api.ts)
// are produced by signing protocol-tagged messages with the wallet key. If a
// website could obtain those exact signatures through signMessage, it would
// hold a write session on the member's API account — a textbook
// cross-protocol phishing attack. Every API message family is refused:
//   fims-wallet-v3\n  request + link-address signatures (5-min replay window)
//   fims-confirm\n    step-up confirmations for destructive actions
const FORBIDDEN_MESSAGE_PREFIXES = ['fims-wallet-v3\n', 'fims-confirm\n']

// The SIWS session-mint message carries no protocol prefix — it looks like a
// generic sign-in — but the server rebuilds it verbatim from request fields,
// so the fixed sentence is the only reliable marker to refuse on.
const FORBIDDEN_MESSAGE_MARKERS = ['Signs you in to the FiMs API']

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
  const text = new TextDecoder().decode(message)
  for (const marker of FORBIDDEN_MESSAGE_MARKERS) {
    if (text.includes(marker)) {
      throw new Error('refusing to sign a wallet-API authentication message')
    }
  }
  if (isLikelyTransaction(message)) {
    throw new Error('refusing to sign a transaction as a message')
  }
}
