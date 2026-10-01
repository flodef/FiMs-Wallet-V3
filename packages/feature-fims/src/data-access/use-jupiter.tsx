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
import { useCallback } from 'react'
import { z } from 'zod'

const JUPITER_API = 'https://lite-api.jup.ag'

function useSignAndSendTransaction({ account, network }: { account: Account; network: Network }) {
  const client = useSolanaClient({ network })
  const accountSecretKey = useAccountSecretKey()
  return useCallback(
    async (base64Transaction: string): Promise<Signature> => {
      const decoded = getTransactionDecoder().decode(getBase64Encoder().encode(base64Transaction))
      const json = await accountSecretKey({ account })
      const signer = await createKeyPairSignerFromJson({ json })
      const signed = await signTransactionWithSigners([signer], decoded)
      const sendTransaction = sendTransactionWithoutConfirmingFactory({ rpc: client.rpc })
      await sendTransaction(signed, { commitment: 'confirmed' })
      return getSignatureFromTransaction(signed)
    },
    [account, accountSecretKey, client.rpc],
  )
}

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
      const url = new URL(`${JUPITER_API}/swap/v1/quote`)
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
  const signAndSendBase64Transaction = useSignAndSendTransaction({ account, network })

  return useMutation({
    mutationFn: async (quote: JupiterQuote): Promise<Signature> => {
      const res = await fetch(`${JUPITER_API}/swap/v1/swap`, {
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
      const { swapTransaction } = z.object({ swapTransaction: z.string() }).parse(await res.json())
      return signAndSendBase64Transaction(swapTransaction)
    },
  })
}

const triggerOrderSchema = z
  .object({
    inputMint: z.string().optional(),
    makingAmount: z.string().optional(),
    orderKey: z.string().optional(),
    outputMint: z.string().optional(),
    takingAmount: z.string().optional(),
  })
  .passthrough()

export type FimsTriggerOrder = z.infer<typeof triggerOrderSchema>

export function useFimsTriggerOrders({ account }: { account: Account }) {
  return useQuery({
    queryFn: async (): Promise<FimsTriggerOrder[]> => {
      const url = new URL(`${JUPITER_API}/trigger/v1/getTriggerOrders`)
      url.searchParams.set('user', account.publicKey)
      url.searchParams.set('orderStatus', 'active')
      const res = await fetch(url)
      if (!res.ok) {
        throw new Error(`Jupiter trigger orders failed: ${res.status}`)
      }
      const json: unknown = await res.json()
      const list = Array.isArray(json) ? json : ((json as { orders?: unknown[] }).orders ?? [])
      return z.array(triggerOrderSchema).parse(list)
    },
    queryKey: ['fims', 'jupiter-trigger-orders', account.publicKey],
  })
}

export function useFimsTriggerCreateOrder({ account, network }: { account: Account; network: Network }) {
  const signAndSendBase64Transaction = useSignAndSendTransaction({ account, network })

  return useMutation({
    mutationFn: async ({
      inputMint,
      makingAmount,
      outputMint,
      takingAmount,
    }: {
      inputMint: string
      makingAmount: bigint
      outputMint: string
      takingAmount: bigint
    }): Promise<Signature> => {
      const res = await fetch(`${JUPITER_API}/trigger/v1/createOrder`, {
        body: JSON.stringify({
          inputMint,
          maker: account.publicKey,
          outputMint,
          params: {
            makingAmount: String(makingAmount),
            takingAmount: String(takingAmount),
          },
          payer: account.publicKey,
        }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      })
      if (!res.ok) {
        throw new Error(`Jupiter trigger order failed: ${res.status}`)
      }
      const { transaction } = z.object({ transaction: z.string() }).parse(await res.json())
      return signAndSendBase64Transaction(transaction)
    },
  })
}

export function useFimsTriggerCancelOrder({ account, network }: { account: Account; network: Network }) {
  const signAndSendBase64Transaction = useSignAndSendTransaction({ account, network })

  return useMutation({
    mutationFn: async (orderKey: string): Promise<Signature> => {
      const res = await fetch(`${JUPITER_API}/trigger/v1/cancelOrder`, {
        body: JSON.stringify({ maker: account.publicKey, order: orderKey }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      })
      if (!res.ok) {
        throw new Error(`Jupiter cancel order failed: ${res.status}`)
      }
      const { transaction } = z.object({ transaction: z.string() }).parse(await res.json())
      return signAndSendBase64Transaction(transaction)
    },
  })
}
