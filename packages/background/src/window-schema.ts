import type {
  SolanaSignAndSendTransactionInput,
  SolanaSignAndSendTransactionOutput,
  SolanaSignInInput,
  SolanaSignInOutput,
  SolanaSignMessageInput,
  SolanaSignMessageOutput,
  SolanaSignTransactionInput,
  SolanaSignTransactionOutput,
} from '@solana/wallet-standard-features'
import type { StandardConnectInput, StandardConnectOutput } from '@wallet-standard/core'

// Page-facing API (window custom events): the dApp only sends inputs — the
// content script adds the trusted origin when relaying to the background
// worker (see extension.ts Schema).
export interface PageSchema {
  connect(input?: StandardConnectInput): Promise<StandardConnectOutput>
  disconnect(): Promise<void>
  signAndSendTransaction(inputs: SolanaSignAndSendTransactionInput[]): Promise<SolanaSignAndSendTransactionOutput[]>
  signIn(inputs: SolanaSignInInput[]): Promise<SolanaSignInOutput[]>
  signMessage(inputs: SolanaSignMessageInput[]): Promise<SolanaSignMessageOutput[]>
  signTransaction(inputs: SolanaSignTransactionInput[]): Promise<SolanaSignTransactionOutput[]>
}
