import {
  getBase64Encoder,
  getSignatureFromTransaction,
  getTransactionDecoder,
  type Signature,
  sendTransactionWithoutConfirmingFactory,
  signTransactionWithSigners,
} from '@solana/kit'
import { useMutation, useQuery } from '@tanstack/react-query'
import type { Account } from '@workspace/db/account/account'
import type { Network } from '@workspace/db/network/network'
import { useAccountSecretKey } from '@workspace/db-react/use-account-secret-key'
import { createKeyPairSignerFromJson } from '@workspace/keypair/create-key-pair-signer-from-json'
import { useSolanaClient } from '@workspace/solana-client-react/use-solana-client'
import { z } from 'zod'

const JUPITER_API = 'https://lite-api.jup.ag/swap/v1'

const jupiterQuoteSchema = z
  .object({
    inAmount: z.string(),
    inputMint: z.string(),
    otherAmountThreshold: z.string(),
    outAmount: z.string(),
    outputMint: z.string(),
    priceImpactPct: z.string().optional(),
  })
  .passthrough()

export type JupiterQuote = z.infer<typeof jupiterQuoteSchema>

export function useJupiterQuote({
  amount,
  inputMint,
  outputMint,
  slippageBps = 50,
}: {
  amount: bigint
  inputMint: string | undefined
  outputMint: string | undefined
  slippageBps?: number
}) {
  return useQuery({
    enabled: !!inputMint && !!outputMint && inputMint !== outputMint && amount > 0n,
    queryFn: async (): Promise<JupiterQuote> => {
      const url = new URL(`${JUPITER_API}/quote`)
      url.searchParams.set('inputMint', inputMint ?? '')
      url.searchParams.set('outputMint', outputMint ?? '')
      url.searchParams.set('amount', String(amount))
      url.searchParams.set('slippageBps', String(slippageBps))
      const res = await fetch(url)
      if (!res.ok) {
        throw new Error(`Jupiter quote failed: ${res.status}`)
      }
      return jupiterQuoteSchema.parse(await res.json())
    },
    queryKey: ['fims', 'jupiter-quote', inputMint, outputMint, String(amount), slippageBps],
    staleTime: 10_000,
  })
}

export function useFimsSwap({ account, network }: { account: Account; network: Network }) {
  const client = useSolanaClient({ network })
  const accountSecretKey = useAccountSecretKey()

  return useMutation({
    mutationFn: async (quote: JupiterQuote): Promise<Signature> => {
      const res = await fetch(`${JUPITER_API}/swap`, {
        body: JSON.stringify({
          dynamicComputeUnitLimit: true,
          prioritizationFeeLamports: 'auto',
          quoteResponse: quote,
          userPublicKey: account.publicKey,
          wrapAndUnwrapSol: true,
        }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      })
      if (!res.ok) {
        throw new Error(`Jupiter swap failed: ${res.status}`)
      }
      const { swapTransaction } = (await res.json()) as { swapTransaction: string }

      const decoded = getTransactionDecoder().decode(getBase64Encoder().encode(swapTransaction))
      const json = await accountSecretKey({ account })
      const signer = await createKeyPairSignerFromJson({ json })
      const signed = await signTransactionWithSigners([signer], decoded)

      const sendTransaction = sendTransactionWithoutConfirmingFactory({ rpc: client.rpc })
      await sendTransaction(signed, { commitment: 'confirmed' })
      return getSignatureFromTransaction(signed)
    },
  })
}
