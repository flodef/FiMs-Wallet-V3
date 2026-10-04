import type { Address } from '@solana/kit'
import type { Account } from '@workspace/db/account/account'
import type { Network } from '@workspace/db/network/network'
import { useAccountGetTransactionSigner } from '@workspace/db-react/use-account-get-transaction-signer'
import { planWalletMigration, type WalletMigrationPlan } from '@workspace/solana-client/plan-wallet-migration'
import { sendSimulatedPreparedTransaction } from '@workspace/solana-client/send-prepared-transaction'
import { useSolanaClient } from '@workspace/solana-client-react/use-solana-client'
import { useCallback } from 'react'

export interface WalletMigrationProgress {
  current: number
  signature?: string
  total: number
}

// On-chain asset migration: plans the transfer of every token account + the
// SOL sweep to a destination address, then executes the instruction batches
// sequentially (each simulated before sending). The source account's secret
// never leaves the vault — it only signs the migration transactions.
export function useWalletMigration(account: Account, network: Network) {
  const client = useSolanaClient({ network })
  const getTransactionSigner = useAccountGetTransactionSigner({ account })

  const plan = useCallback(
    async (destination: Address): Promise<WalletMigrationPlan> => {
      const transactionSigner = await getTransactionSigner()
      return planWalletMigration(client, { destination, source: transactionSigner })
    },
    [client, getTransactionSigner],
  )

  const execute = useCallback(
    async ({
      batches,
      onProgress,
    }: {
      batches: WalletMigrationPlan['batches']
      onProgress?: (progress: WalletMigrationProgress) => void
    }): Promise<string[]> => {
      const transactionSigner = await getTransactionSigner()
      const signatures: string[] = []
      for (const [index, instructions] of batches.entries()) {
        onProgress?.({ current: index + 1, total: batches.length })
        const result = await sendSimulatedPreparedTransaction(client, { instructions, transactionSigner })
        if (!result.signature) {
          throw new Error(`migration batch ${index + 1}/${batches.length} failed simulation`)
        }
        signatures.push(`${result.signature}`)
        onProgress?.({ current: index + 1, signature: `${result.signature}`, total: batches.length })
      }
      return signatures
    },
    [client, getTransactionSigner],
  )

  return { execute, plan }
}
