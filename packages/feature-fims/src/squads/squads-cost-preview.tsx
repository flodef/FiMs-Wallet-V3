import { type Address, createNoopSigner, type Instruction } from '@solana/kit'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from '@workspace/i18n'
import { lamportsToSol } from '@workspace/solana-client/lamports-to-sol'
import {
  type SimulatePreparedTransactionResult,
  simulatePreparedTransaction,
} from '@workspace/solana-client/simulate-prepared-transaction'
import type { SolanaClient } from '@workspace/solana-client/solana-client'
import { UiLoader } from '@workspace/ui/components/ui-loader'

export interface SquadsCostEstimate {
  fee: bigint | undefined
  other: bigint | undefined
  total: bigint | undefined
}

// The fee payer's simulated balance delta covers everything the transaction
// debits: network fee + rent for new accounts + protocol fees. Splitting it
// out gives an honest cost preview before anyone signs.
export function squadsEstimateCost(input: {
  payer: Address
  simulation: SimulatePreparedTransactionResult
}): SquadsCostEstimate {
  const fee = input.simulation.fee
  const payerChange = input.simulation.solBalanceChanges.find((change) => change.address === input.payer)?.change
  const total = payerChange != null && payerChange < 0n ? -payerChange : fee
  const other = total != null ? total - (fee ?? 0n) : undefined
  return { fee, other, total }
}

function formatLamports(lamports: bigint | undefined): string {
  return lamports == null ? '—' : `${lamportsToSol(lamports)} SOL`
}

// Simulates the (unsigned) transaction to price it: sigVerify is off in the
// simulation pipeline so a noop signer standing in for the payer is enough.
export function SquadsCostPreview({
  buildInstructions,
  client,
  inputKey,
  payer,
  protocolFee,
}: {
  buildInstructions: () => Instruction[] | Promise<Instruction[]>
  client: SolanaClient
  inputKey: string
  payer: Address
  protocolFee?: bigint | undefined
}) {
  const { t } = useTranslation('fims')
  const estimate = useQuery({
    enabled: inputKey.length > 0,
    queryFn: async () => {
      const instructions = await buildInstructions()
      return simulatePreparedTransaction(client, {
        instructions,
        transactionSigner: createNoopSigner(payer),
      })
    },
    queryKey: ['squads', 'cost', inputKey, payer],
    retry: false,
    staleTime: 30_000,
  })

  if (inputKey.length === 0) {
    return null
  }
  if (estimate.isFetching) {
    return (
      <div className="flex items-center gap-2 text-muted-foreground text-xs">
        <UiLoader className="size-3" />
        {t(($) => $.multisigCostLoading)}
      </div>
    )
  }
  if (!estimate.data) {
    return null
  }

  const cost = squadsEstimateCost({ payer, simulation: estimate.data })
  const rent = cost.other != null ? cost.other - (protocolFee ?? 0n) : undefined

  return (
    <div className="space-y-1 rounded-md border border-dashed p-3 text-xs">
      <div className="font-medium">{t(($) => $.multisigCostTitle)}</div>
      <div className="flex justify-between text-muted-foreground">
        <span>{t(($) => $.multisigCostNetwork)}</span>
        <span className="font-mono">{formatLamports(cost.fee)}</span>
      </div>
      {protocolFee != null && protocolFee > 0n ? (
        <div className="flex justify-between text-muted-foreground">
          <span>{t(($) => $.multisigCostProtocol)}</span>
          <span className="font-mono">{formatLamports(protocolFee)}</span>
        </div>
      ) : null}
      {rent != null && rent > 0n ? (
        <div className="flex justify-between text-muted-foreground">
          <span>{t(($) => $.multisigCostAccounts)}</span>
          <span className="font-mono">≈ {formatLamports(rent)}</span>
        </div>
      ) : null}
      <div className="flex justify-between font-medium">
        <span>{t(($) => $.multisigCostTotal)}</span>
        <span className="font-mono">≈ {formatLamports(cost.total)}</span>
      </div>
      {estimate.data.status === 'failure' ? (
        <p className="text-muted-foreground">{t(($) => $.multisigCostEstimateOnly)}</p>
      ) : null}
    </div>
  )
}
