import {
  type Base64EncodedWireTransaction,
  getBase64EncodedWireTransaction,
  getBase64Encoder,
  getSignatureFromTransaction,
  getTransactionDecoder,
  isTransactionModifyingSigner,
  isTransactionPartialSigner,
  type Signature,
  signTransactionWithSigners,
  type TransactionSigner,
} from '@solana/kit'
import type { SolanaClient } from './solana-client.ts'

// Signs an already-compiled wire transaction (Solana Pay transaction
// request, merchant callback tx) preserving any merchant pre-signatures,
// asserts every required signature is present, then sends and confirms it.
export async function signAndSendWireTransaction(
  client: SolanaClient,
  base64Transaction: string,
  signer: TransactionSigner,
): Promise<Signature> {
  if (!isTransactionPartialSigner(signer) && !isTransactionModifyingSigner(signer)) {
    throw new Error('Wallet cannot sign transactions without sending them')
  }
  const transaction = getTransactionDecoder().decode(getBase64Encoder().encode(base64Transaction) as Uint8Array)
  const signed = await signTransactionWithSigners([signer], transaction)
  const signature = getSignatureFromTransaction(signed)

  const wire = getBase64EncodedWireTransaction(signed) as Base64EncodedWireTransaction
  await client.rpc.sendTransaction(wire, { encoding: 'base64' }).send()

  // sendAndConfirmTransactionFactory needs a lifetime constraint on the
  // object — a decoded wire tx carries its blockhash inside messageBytes —
  // so confirmation falls back to status polling.
  for (let attempt = 0; attempt < 40; attempt++) {
    const { value } = await client.rpc.getSignatureStatuses([signature], { searchTransactionHistory: true }).send()
    const status = value[0]
    if (status?.err) {
      throw new Error(`transaction failed: ${JSON.stringify(status.err)}`)
    }
    if (status && (status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized')) {
      return signature
    }
    await new Promise((resolve) => setTimeout(resolve, 750))
  }
  throw new Error('transaction was not confirmed in time')
}
