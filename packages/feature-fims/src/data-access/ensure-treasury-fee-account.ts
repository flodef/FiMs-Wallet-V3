import type { Address, TransactionSigner } from '@solana/kit'
import { TOKEN_PROGRAM_ADDRESS } from '@solana-program/token'
import { createGetOrCreateAtaInstruction } from '@workspace/solana-client/create-get-or-create-ata-instruction'
import { sendPreparedTransaction } from '@workspace/solana-client/send-prepared-transaction'
import type { SolanaClient } from '@workspace/solana-client/solana-client'
import { FIMS_TREASURY_ADDRESS } from '../fims-constants.ts'

// The fee account Jupiter charges platformFeeBps / feeBps into must be an
// initialized ATA of the fee mint owned by the treasury. It is created
// lazily on first use: the user's signer pays the ~0.002 SOL rent once,
// afterwards every swap/order on that mint feeds it automatically.
export async function ensureTreasuryFeeAccount(
  client: SolanaClient,
  { mint, transactionSigner }: { mint: Address; transactionSigner: TransactionSigner },
): Promise<Address> {
  const owner = FIMS_TREASURY_ADDRESS as Address
  const [ata, createInstruction] = await createGetOrCreateAtaInstruction({
    mint,
    owner,
    tokenProgram: TOKEN_PROGRAM_ADDRESS,
    transactionSigner,
  })
  const accountInfo = await client.rpc.getAccountInfo(ata, { encoding: 'base64' }).send()
  if (accountInfo.value) {
    return ata
  }
  await sendPreparedTransaction(client, { instructions: [createInstruction], transactionSigner })
  return ata
}
