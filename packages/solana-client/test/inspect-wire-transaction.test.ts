import {
  appendTransactionMessageInstructions,
  type Blockhash,
  compileTransactionMessage,
  createTransactionMessage,
  generateKeyPairSigner,
  getBase64Decoder,
  getCompiledTransactionMessageEncoder,
  getTransactionEncoder,
  lamports,
  pipe,
  type SignatureBytes,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  type TransactionMessageBytes,
} from '@solana/kit'
import { getTransferSolInstruction, SYSTEM_PROGRAM_ADDRESS } from '@solana-program/system'
import { getTransferCheckedInstruction, TOKEN_PROGRAM_ADDRESS } from '@solana-program/token'
import { describe, expect, it } from 'vitest'
import { inspectWireTransaction } from '../src/inspect-wire-transaction.ts'
import type { SolanaClient } from '../src/solana-client.ts'

const BLOCKHASH = 'EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N' as Blockhash
const TOKEN_TRANSFER_CHECKED_DISCRIMINATOR = 12
const SYSTEM_TRANSFER_DISCRIMINATOR = 2

// Minimal client: decode-level assertions never inspect simulation results,
// so the RPC stubs return empty-but-shaped responses.
const stubClient = () =>
  ({
    rpc: {
      getMultipleAccounts: () => ({ send: async () => ({ value: [] }) }),
      simulateTransaction: () => ({ send: async () => ({ value: { accounts: [], err: null } }) }),
    },
  }) as unknown as SolanaClient

describe('inspect-wire-transaction', () => {
  describe('expected behavior', () => {
    it('should decode instruction data and program ids of a v1 wire transaction', async () => {
      // ARRANGE
      expect.assertions(6)
      const signer = await generateKeyPairSigner()
      const destination = (await generateKeyPairSigner()).address
      const transfer = getTransferSolInstruction({ amount: lamports(1_000_000n), destination, source: signer })
      const tokenTransfer = getTransferCheckedInstruction({
        amount: 500_000n,
        authority: signer.address,
        decimals: 6,
        destination,
        mint: destination,
        source: signer.address,
      })
      const message = pipe(
        createTransactionMessage({ version: 1 }),
        (tx) => setTransactionMessageFeePayerSigner(signer, tx),
        (tx) => appendTransactionMessageInstructions([transfer, tokenTransfer], tx),
        (tx) => setTransactionMessageLifetimeUsingBlockhash({ blockhash: BLOCKHASH, lastValidBlockHeight: 100n }, tx),
      )
      const messageBytes = getCompiledTransactionMessageEncoder().encode(
        compileTransactionMessage(message),
      ) as TransactionMessageBytes
      const wire = getBase64Decoder().decode(
        getTransactionEncoder().encode({
          messageBytes,
          // One (empty) signature slot per required signer — inspect's
          // `alreadySignedBy` filter ignores all-zero signatures.
          signatures: { [signer.address]: new Uint8Array(64) as SignatureBytes },
        }),
      )

      // ACT
      const result = await inspectWireTransaction(stubClient(), wire)

      // ASSERT — before the `instructionData` fix this came back empty, which
      // silently disabled every instruction-level guard (system type, token
      // discriminators, close destinations).
      const [transferIx, tokenIx] = result.instructions
      expect(transferIx?.programId).toBe(SYSTEM_PROGRAM_ADDRESS)
      // System transfer = u32 discriminator (2) + u64 lamports.
      expect([...(transferIx?.data.slice(0, 4) ?? [])]).toEqual([SYSTEM_TRANSFER_DISCRIMINATOR, 0, 0, 0])
      expect(tokenIx?.programId).toBe(TOKEN_PROGRAM_ADDRESS)
      expect(tokenIx?.data[0]).toBe(TOKEN_TRANSFER_CHECKED_DISCRIMINATOR)
      expect(result.feePayer).toBe(signer.address)
      expect(result.instructions.every((ix) => !ix.hasUnresolvedAccounts)).toBe(true)
    })
  })
})
