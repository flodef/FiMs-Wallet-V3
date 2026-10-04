import type { Address } from '@solana/kit'
import { getTransferSolInstruction } from '@solana-program/system'
import { queryOptions, useQuery } from '@tanstack/react-query'
import type { Network } from '@workspace/db/network/network'
import { NATIVE_MINT } from '@workspace/solana-client/constants'
import { createMemoInstruction } from '@workspace/solana-client/create-memo-instruction'
import { getBalance } from '@workspace/solana-client/get-balance'
import { prepareTransactionSol } from '@workspace/solana-client/prepare-transaction-sol'
import { prepareTransactionSpl } from '@workspace/solana-client/prepare-transaction-spl'
import type { PreparedTransaction } from '@workspace/solana-client/send-prepared-transaction'
import type { SolanaClient } from '@workspace/solana-client/solana-client'
import type { GetTransactionSigner } from '@workspace/solana-client/transaction-signer'
import type { TransferRecipient } from '@workspace/solana-client/transfer-recipient'
import { useSolanaClient } from '@workspace/solana-client-react/use-solana-client'
import type { TokenBalance } from './use-get-token-balances.ts'

export interface PortfolioPreparedTransaction extends PreparedTransaction {
  mint: TokenBalance
  recipients: TransferRecipient[]
}

export interface PortfolioTxPrepareInput {
  // Solana Pay request fields: appended as a Memo instruction carrying the
  // memo text with the request's reference keys as read-only accounts.
  memo?: string | undefined
  mint: TokenBalance
  recipients: TransferRecipient[]
  references?: Address[] | undefined
  // Optional SOL-denominated fee collected by a third party (e.g. the FiMs
  // operating fee): appended as an extra lamports transfer instruction. Kept
  // out of `recipients` so the confirmation screen only lists user targets.
  solFee?: TransferRecipient | undefined
}

function portfolioTxPrepareQueryOptions({
  client,
  getTransactionSigner,
  input,
  network,
  transactionSignerAddress,
}: {
  client: SolanaClient
  getTransactionSigner: GetTransactionSigner
  input: PortfolioTxPrepareInput | undefined
  network: Network
  transactionSignerAddress: Address
}) {
  const recipients = input?.recipients.map(({ amount, destination }) => ({
    amount: amount.toString(),
    destination,
  }))
  const solFee = input?.solFee
    ? { amount: input.solFee.amount.toString(), destination: input.solFee.destination }
    : undefined

  const payFields =
    input && (input.memo != null || input.references?.length)
      ? { memo: input.memo ?? '', references: input.references ?? [] }
      : undefined

  return queryOptions({
    enabled: !!input,
    queryFn: async (): Promise<PortfolioPreparedTransaction> => {
      if (!input) {
        throw new Error('No transaction input')
      }

      const transactionSigner = await getTransactionSigner()
      const payMemo =
        input.memo != null || input.references?.length
          ? createMemoInstruction({ memo: input.memo ?? '', references: input.references ?? [] })
          : undefined
      const preparedTransaction =
        input.mint.mint === NATIVE_MINT
          ? prepareTransactionSol({
              // The fee rides the SOL recipients list so the sendable-amount
              // validation accounts for it; the UI still shows only the real
              // recipients via the `recipients` field below.
              recipients: input.solFee ? [...input.recipients, input.solFee] : input.recipients,
              senderBalance: await getBalance(client, { address: transactionSigner.address }).then((res) => res.value),
              transactionSigner,
            })
          : await prepareTransactionSpl(client, {
              mint: input.mint.mint,
              recipients: input.recipients,
              transactionSigner,
            }).then((prepared) =>
              input.solFee
                ? {
                    ...prepared,
                    instructions: [
                      ...prepared.instructions,
                      getTransferSolInstruction({
                        amount: input.solFee.amount,
                        destination: input.solFee.destination,
                        source: transactionSigner,
                      }),
                    ],
                  }
                : prepared,
            )

      return {
        ...preparedTransaction,
        instructions: payMemo ? [...preparedTransaction.instructions, payMemo] : preparedTransaction.instructions,
        mint: input.mint,
        recipients: input.recipients,
      }
    },
    queryKey: [
      'portfolioTxPrepare',
      network.endpoint,
      transactionSignerAddress,
      input?.mint.mint,
      recipients,
      solFee,
      payFields,
    ],
  })
}

export function usePortfolioTxPrepare({
  getTransactionSigner,
  input,
  network,
  transactionSignerAddress,
}: {
  getTransactionSigner: GetTransactionSigner
  input: PortfolioTxPrepareInput | undefined
  network: Network
  transactionSignerAddress: Address
}) {
  const client = useSolanaClient({ network })

  return useQuery(
    portfolioTxPrepareQueryOptions({ client, getTransactionSigner, input, network, transactionSignerAddress }),
  )
}
