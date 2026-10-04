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

export type WalletStandardSigner = MessagePartialSigner & TransactionPartialSigner

// Adapts an injected wallet-standard wallet (Phantom, Solflare, Jupiter…)
// to the signer interfaces used throughout the app. The external wallet
// signs — no key material ever touches this app.
export function createWalletStandardSigner(wallet: Wallet, account: WalletAccount): WalletStandardSigner {
  const address = account.address as Address

  return {
    address,

    signMessages: async (messages) => {
      const feature = wallet.features[SolanaSignMessage] as
        | SolanaSignMessageFeature[typeof SolanaSignMessage]
        | undefined
      if (!feature) {
        throw new Error(`${wallet.name} does not support message signing`)
      }
      const results = await feature.signMessage(...messages.map((message) => ({ account, message: message.content })))
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
