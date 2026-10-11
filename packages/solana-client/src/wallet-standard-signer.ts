import {
  type Address,
  getTransactionDecoder,
  getTransactionEncoder,
  type MessagePartialSigner,
  type SignatureBytes,
  type TransactionPartialSigner,
} from '@solana/kit'
import {
  SolanaSignMessage,
  type SolanaSignMessageFeature,
  SolanaSignTransaction,
  type SolanaSignTransactionFeature,
} from '@solana/wallet-standard-features'
import type { Wallet, WalletAccount } from '@wallet-standard/core'

export type WalletStandardSigner = MessagePartialSigner &
  TransactionPartialSigner & {
    // Wallet-standard signMessage may sign a prefixed/modified copy of the
    // bytes passed in — `signature` only covers `signedMessage`, so the real
    // signed bytes must reach the verifier (see signContentBytes helper).
    signContentBytes: (content: Uint8Array) => Promise<{ signature: Uint8Array; signedMessage: Uint8Array }>
  }

// Adapts an injected wallet-standard wallet (Phantom, Solflare, Jupiter…)
// to the signer interfaces used throughout the app. The external wallet
// signs — no key material ever touches this app.
export function createWalletStandardSigner(wallet: Wallet, account: WalletAccount): WalletStandardSigner {
  const address = account.address as Address

  const signMessageFeature = () => {
    const feature = wallet.features[SolanaSignMessage] as SolanaSignMessageFeature[typeof SolanaSignMessage] | undefined
    if (!feature) {
      throw new Error(`${wallet.name} does not support message signing`)
    }
    return feature
  }

  const signContentBytes = async (content: Uint8Array) => {
    const [result] = await signMessageFeature().signMessage({ account, message: content })
    if (!result) {
      throw new Error(`${wallet.name} did not sign the message`)
    }
    return { signature: result.signature, signedMessage: result.signedMessage ?? content }
  }

  return {
    address,

    signContentBytes,

    signMessages: async (messages) => {
      const results = await signMessageFeature().signMessage(
        ...messages.map((message) => ({ account, message: message.content })),
      )
      return results.map((result) => ({ [address]: result.signature as SignatureBytes }))
    },

    signTransactions: async (transactions) => {
      const feature = wallet.features[SolanaSignTransaction] as
        | SolanaSignTransactionFeature[typeof SolanaSignTransaction]
        | undefined
      if (!feature) {
        throw new Error(`${wallet.name} does not support transaction signing`)
      }
      const encoder = getTransactionEncoder()
      const decoder = getTransactionDecoder()
      const results = await feature.signTransaction(
        ...transactions.map((transaction) => ({
          account,
          transaction: new Uint8Array(encoder.encode(transaction)),
        })),
      )
      return results.map((result) => {
        const signature = decoder.decode(result.signedTransaction).signatures[address]
        if (!signature) {
          throw new Error(`${wallet.name} did not sign for ${address}`)
        }
        return { [address]: signature }
      })
    },
  }
}
