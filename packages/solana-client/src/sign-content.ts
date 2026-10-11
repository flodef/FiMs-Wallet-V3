import type { MessagePartialSigner } from '@solana/kit'

export interface SignedContent {
  signature: Uint8Array
  signedMessage: Uint8Array
}

// Signs `content` and returns the exact bytes the signature covers.
// Wallet-standard wallets may sign a prefixed/modified copy (Solflare adds a
// domain preamble) — their signers expose `signContentBytes`, which returns
// the wallet's own signedMessage. Other signers (local keypairs) sign the
// content verbatim, so signedMessage === content.
export async function signContentBytes(signer: MessagePartialSigner, content: Uint8Array): Promise<SignedContent> {
  const raw = (signer as { signContentBytes?: (c: Uint8Array) => Promise<SignedContent> }).signContentBytes
  if (raw) {
    const { signature, signedMessage } = await raw(content)
    if (!signature?.length) {
      throw new Error('wallet did not sign the message')
    }
    return { signature, signedMessage: signedMessage?.length ? signedMessage : content }
  }
  const [signatures] = await signer.signMessages([{ content, signatures: {} }])
  const signature = signatures?.[signer.address]
  if (!signature) {
    throw new Error('wallet did not sign the message')
  }
  return { signature, signedMessage: content }
}

export function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, i) => byte === b[i])
}
