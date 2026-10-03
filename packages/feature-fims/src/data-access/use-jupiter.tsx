import type { Address } from '@solana/kit'
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
import { inspectWireTransaction } from '@workspace/solana-client/inspect-wire-transaction'
import { useSolanaClient } from '@workspace/solana-client-react/use-solana-client'
import { useCallback } from 'react'
import { z } from 'zod'
import { assertJupiterTransactionSafe } from './inspect-jupiter-transaction.ts'

const JUPITER_API = 'https://lite-api.jup.ag'

// Every transaction Jupiter hands us is inspected locally before signing:
// fee payer / signers / program allowlist are checked statically, and the
// transaction is simulated to cap what can leave the wallet AND what must
// come back. A tampered or malicious Jupiter response is rejected instead
// of being signed blindly.
function useSignAndSendTransaction({ account, network }: { account: Account; network: Network }) {
  const client = useSolanaClient({ network })
  const accountSecretKey = useAccountSecretKey()
  return useCallback(
    async (
      base64Transaction: string,
      expectedSpend?: { amount: bigint; mint: Address },
      expectedReceive?: { amount: bigint; mint: Address },
    ): Promise<Signature> => {
      const inspection = await inspectWireTransaction(client, base64Transaction)
      assertJupiterTransactionSafe({ account: account.publicKey, expectedReceive, expectedSpend, inspection })
      const decoded = getTransactionDecoder().decode(getBase64Encoder().encode(base64Transaction))
      const json = await accountSecretKey({ account })
      const signer = await createKeyPairSignerFromJson({ json })
      const signed = await signTransactionWithSigners([signer], decoded)
      const sendTransaction = sendTransactionWithoutConfirmingFactory({ rpc: client.rpc })
      await sendTransaction(signed, { commitment: 'confirmed' })
      return getSignatureFromTransaction(signed)
    },
    [account, accountSecretKey, client],
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
      return signAndSendBase64Transaction(
        swapTransaction,
        {
          amount: BigInt(quote.inAmount),
          mint: quote.inputMint as Address,
        },
        // The wallet must receive at least the quote's min-out of the mint
        // the user selected: a spoofed output mint or a minOut of zero is
        // rejected by the inspection, not signed.
        {
          amount: BigInt(quote.otherAmountThreshold),
          mint: quote.outputMint as Address,
        },
      )
    },
  })
}

// Swap whose output mint is delivered straight into somebody else's token
// account (exchange / Jupiter Spend deposit). Jupiter builds a single
// transaction containing the swap plus the transfer — and the ATA creation
// for the destination when needed — so the user signs once.
export function useFimsSwapTo({ account, network }: { account: Account; network: Network }) {
  const signAndSendBase64Transaction = useSignAndSendTransaction({ account, network })

  return useMutation({
    mutationFn: async ({
      destinationTokenAccount,
      quote,
    }: {
      destinationTokenAccount: Address
      quote: JupiterQuote
    }): Promise<Signature> => {
      const res = await fetch(`${JUPITER_API}/swap/v1/swap`, {
        body: JSON.stringify({
          destinationTokenAccount,
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
      // The output lands in the destination's ATA, not ours — the wallet
      // spends the input mint and receives nothing, so only the spend side
      // is asserted (expectedReceive stays undefined on purpose).
      return signAndSendBase64Transaction(swapTransaction, {
        amount: BigInt(quote.inAmount),
        mint: quote.inputMint as Address,
      })
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
      return signAndSendBase64Transaction(transaction, {
        amount: makingAmount,
        mint: inputMint as Address,
      })
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
