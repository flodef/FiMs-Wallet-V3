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
import type { Request } from './services/request.ts'

// Every request carries the page origin captured by the content script —
// the background service never trusts an origin supplied inside the payload.
export interface Schema {
  connect(request: { input: StandardConnectInput | undefined; origin: string }): Promise<StandardConnectOutput>
  disconnect(request: { origin: string }): Promise<void>
  onRequestCreate(request: Request): void
  onRequestReset(): void
  signAndSendTransaction(request: {
    inputs: SolanaSignAndSendTransactionInput[]
    origin: string
  }): Promise<SolanaSignAndSendTransactionOutput[]>
  signIn(request: { inputs: SolanaSignInInput[]; origin: string }): Promise<SolanaSignInOutput[]>
  signMessage(request: { inputs: SolanaSignMessageInput[]; origin: string }): Promise<SolanaSignMessageOutput[]>
  signTransaction(request: {
    inputs: SolanaSignTransactionInput[]
    origin: string
  }): Promise<SolanaSignTransactionOutput[]>
}
