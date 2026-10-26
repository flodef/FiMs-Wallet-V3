import type { Address, TransactionSigner } from '@solana/kit'
import {
  address,
  getBase64Encoder,
  getSignatureFromTransaction,
  getTransactionDecoder,
  type Instruction,
  type Signature,
  sendTransactionWithoutConfirmingFactory,
  signTransactionWithSigners,
} from '@solana/kit'
import { fetchMint, findAssociatedTokenPda } from '@solana-program/token'
import { useMutation, useQuery } from '@tanstack/react-query'
import type { Account } from '@workspace/db/account/account'
import type { Network } from '@workspace/db/network/network'
import { useAccountGetTransactionSigner } from '@workspace/db-react/use-account-get-transaction-signer'
import { useAccountSecretKey } from '@workspace/db-react/use-account-secret-key'
import { getAccountTransactionVersion } from '@workspace/db-react/use-connected-wallet-signer'
import { createKeyPairSignerFromJson } from '@workspace/keypair/create-key-pair-signer-from-json'
import { NATIVE_MINT } from '@workspace/solana-client/constants'
import { createTransferInstructionsSol } from '@workspace/solana-client/create-transfer-instructions-sol'
import { createTransferInstructionsSpl } from '@workspace/solana-client/create-transfer-instructions-spl'
import { inspectWireTransaction } from '@workspace/solana-client/inspect-wire-transaction'
import type { SolanaClient } from '@workspace/solana-client/solana-client'
import { useSolanaClient } from '@workspace/solana-client-react/use-solana-client'
import { useCallback } from 'react'
import { z } from 'zod'
import { FIMS_TONTINE_ADDRESS, FIMS_TREASURY_ADDRESS } from '../fims-constants.ts'
import { getFimsPlatformFeeBps } from '../fims-fee-config.ts'
import { ensureTreasuryFeeAccount } from './ensure-treasury-fee-account.ts'
import {
  buildDepositIx,
  FIMS_STRATEGY_NATIVE_OVERHEAD_LAMPORTS,
  type FimsStrategyState,
  fetchStrategyState,
  mintTokenProgram,
  vaultPda,
} from './fims-strategy.ts'
import { assertJupiterTransactionSafe } from './inspect-jupiter-transaction.ts'
import {
  compileJupiterWire,
  type JupiterBuild,
  type JupiterQuote,
  jupiterBuildSchema,
  jupiterInstructions,
} from './jupiter-wire.ts'

// Swap V2 (Metis `/swap/v1/*` is deprecated): /build returns the quote and the
// raw instructions in one call so we can append our own (tontine carve,
// strategy deposit) and pick the transaction version the signer supports.
const JUPITER_API = 'https://api.jup.ag'

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
      extraSpends?: { amount: bigint; mint: Address }[],
      expectedReceiveOwner?: Address,
    ): Promise<Signature> => {
      const inspection = await inspectWireTransaction(client, base64Transaction)
      assertJupiterTransactionSafe({
        account: account.publicKey,
        expectedReceive,
        expectedReceiveOwner,
        expectedSpend,
        extraSpends,
        inspection,
      })
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

// Mint → token program, cached: quoting derives the treasury fee ATA
// off-chain and the program never changes for a given mint.
const tokenProgramCache = new Map<Address, Promise<Address>>()
function cachedMintTokenProgram(client: SolanaClient, mint: Address): Promise<Address> {
  let cached = tokenProgramCache.get(mint)
  if (!cached) {
    cached = mintTokenProgram(client.rpc, mint)
    tokenProgramCache.set(mint, cached)
  }
  return cached
}

// Treasury ATA of `mint`, derived only — unlike ensureTreasuryFeeAccount
// nothing is created on-chain, which is all a /build quote needs to price
// the platform fee in.
async function deriveTreasuryFeeAccount(client: SolanaClient, mint: Address): Promise<Address> {
  const [ata] = await findAssociatedTokenPda({
    mint,
    owner: FIMS_TREASURY_ADDRESS as Address,
    tokenProgram: await cachedMintTokenProgram(client, mint),
  })
  return ata
}

async function fetchJupiterBuild({
  amount,
  destinationTokenAccount,
  feeAccount,
  inputMint,
  outputMint,
  platformFeeBps,
  slippageBps = 50,
  taker,
  transactionVersion,
}: {
  amount: bigint
  destinationTokenAccount?: Address | undefined
  feeAccount?: Address | undefined
  inputMint: string
  outputMint: string
  platformFeeBps?: number | undefined
  slippageBps?: number | undefined
  taker: string
  transactionVersion: 0 | 1
}): Promise<JupiterBuild> {
  // /swap/v2/build is retired: the flow is now GET /swap/v2/quote then POST
  // /swap/v2/swap-instructions, merged back into the same JupiterBuild shape —
  // instructions stay raw so we can append ours (tontine carve, deposit).
  const url = new URL(`${JUPITER_API}/swap/v2/quote`)
  url.searchParams.set('inputMint', inputMint)
  url.searchParams.set('outputMint', outputMint)
  url.searchParams.set('amount', String(amount))
  url.searchParams.set('slippageBps', String(slippageBps))
  url.searchParams.set('transactionVersion', String(transactionVersion))
  if (platformFeeBps && feeAccount) {
    url.searchParams.set('platformFeeBps', String(platformFeeBps))
    url.searchParams.set('feeAccount', feeAccount)
  }
  const quoteRes = await fetch(url)
  if (!quoteRes.ok) {
    throw new Error(`Jupiter quote failed: ${quoteRes.status}`)
  }
  const quoteResponse = (await quoteRes.json()) as Record<string, unknown>
  const swapRes = await fetch(`${JUPITER_API}/swap/v2/swap-instructions`, {
    body: JSON.stringify({
      ...(destinationTokenAccount ? { destinationTokenAccount } : {}),
      ...(platformFeeBps && feeAccount ? { feeAccount } : {}),
      quoteResponse,
      taker,
    }),
    headers: { 'content-type': 'application/json' },
    method: 'POST',
  })
  if (!swapRes.ok) {
    throw new Error(`Jupiter swap-instructions failed: ${swapRes.status}`)
  }
  const instructions = (await swapRes.json()) as Record<string, unknown>
  return jupiterBuildSchema.parse({ ...quoteResponse, ...instructions })
}

export function useJupiterQuote({
  account,
  amount,
  inputMint,
  network,
  outputMint,
  platformFeeBps,
  slippageBps = 50,
}: {
  account: Account
  amount: bigint
  inputMint: string | undefined
  network: Network
  outputMint: string | undefined
  platformFeeBps?: number
  slippageBps?: number
}) {
  const client = useSolanaClient({ network })
  return useQuery({
    enabled: !!inputMint && !!outputMint && inputMint !== outputMint && amount > 0n,
    queryFn: async (): Promise<JupiterQuote> => {
      const feeAccount = platformFeeBps ? await deriveTreasuryFeeAccount(client, outputMint as Address) : undefined
      return fetchJupiterBuild({
        amount,
        feeAccount,
        inputMint: inputMint ?? '',
        outputMint: outputMint ?? '',
        platformFeeBps,
        slippageBps,
        taker: account.publicKey,
        transactionVersion: getAccountTransactionVersion(account),
      })
    },
    queryKey: [
      'fims',
      'jupiter-quote',
      account.publicKey,
      getAccountTransactionVersion(account),
      network.id,
      inputMint,
      outputMint,
      String(amount),
      slippageBps,
      platformFeeBps,
    ],
    staleTime: 10_000,
  })
}

// Carve the tontine share of an outgoing amount into the same transaction:
// transferChecked of the sent mint to the pot, whose ATA is created on first
// use. Works for Token-2022 mints too (the mint's program is fetched).
async function buildTontineCarveInstructions(
  client: SolanaClient,
  { amount, mint, transactionSigner }: { amount: bigint; mint: Address; transactionSigner: TransactionSigner },
): Promise<Instruction[]> {
  // Native SOL has no ATA to carve from — a plain lamports transfer does it.
  if (mint === NATIVE_MINT) {
    return createTransferInstructionsSol({
      recipients: [{ amount, destination: FIMS_TONTINE_ADDRESS as Address }],
      source: transactionSigner,
    })
  }
  const mintInfo = await fetchMint(client.rpc, mint)
  return createTransferInstructionsSpl({
    decimals: mintInfo.data.decimals,
    mint,
    recipients: [{ amount, destination: FIMS_TONTINE_ADDRESS as Address }],
    tokenProgram: mintInfo.programAddress,
    transactionSigner,
  })
}

export function useFimsSwap({ account, network }: { account: Account; network: Network }) {
  const client = useSolanaClient({ network })
  const getTransactionSigner = useAccountGetTransactionSigner({ account })
  const signAndSendBase64Transaction = useSignAndSendTransaction({ account, network })

  return useMutation({
    mutationFn: async ({
      feeMint,
      quote,
      tontineAmount,
    }: {
      feeMint?: Address
      quote: JupiterQuote
      // Units of the INPUT mint diverted to the tontine inside the same tx
      // (the quote is already computed on the reduced input).
      tontineAmount?: bigint
    }): Promise<Signature> => {
      // When the quote carries platformFeeBps, /build requires feeAccount: an
      // initialized ATA of the fee mint owned by the treasury, created lazily
      // on first use (user pays the one-time rent).
      const feeAccount = feeMint
        ? await ensureTreasuryFeeAccount(client, { mint: feeMint, transactionSigner: await getTransactionSigner() })
        : undefined
      const body = await fetchJupiterBuild({
        amount: BigInt(quote.inAmount),
        feeAccount,
        inputMint: quote.inputMint,
        outputMint: quote.outputMint,
        platformFeeBps: feeAccount ? getFimsPlatformFeeBps() : undefined,
        taker: account.publicKey,
        transactionVersion: getAccountTransactionVersion(account),
      })
      const transactionSigner = await getTransactionSigner()
      const instructions = jupiterInstructions(body)
      // The tontine transfer rides the same transaction — the carve is
      // appended after Jupiter's own instructions, atomically.
      if (tontineAmount && tontineAmount > 0n) {
        instructions.push(
          ...(await buildTontineCarveInstructions(client, {
            amount: tontineAmount,
            mint: body.inputMint as Address,
            transactionSigner,
          })),
        )
      }
      const wire = await compileJupiterWire(client, {
        body,
        instructions,
        payer: address(account.publicKey),
      })
      return signAndSendBase64Transaction(
        wire,
        { amount: BigInt(body.inAmount), mint: body.inputMint as Address },
        { amount: BigInt(body.otherAmountThreshold), mint: body.outputMint as Address },
        tontineAmount ? [{ amount: tontineAmount, mint: body.inputMint as Address }] : undefined,
      )
    },
  })
}

// Swap whose output mint is delivered straight into somebody else's token
// account (exchange / Jupiter Spend deposit). destinationTokenAccount routes
// the output inside the same transaction — and since /build hands us the raw
// instructions, the tontine carve rides along too: the member signs once.
export function useFimsSwapTo({ account, network }: { account: Account; network: Network }) {
  const client = useSolanaClient({ network })
  const getTransactionSigner = useAccountGetTransactionSigner({ account })
  const signAndSendBase64Transaction = useSignAndSendTransaction({ account, network })

  return useMutation({
    mutationFn: async ({
      destinationTokenAccount,
      feeMint,
      quote,
      tontineAmount,
    }: {
      destinationTokenAccount: Address
      // Fee mint of a quote carrying platformFeeBps — /build requires the
      // treasury ATA, created lazily on first use (member pays the rent).
      feeMint?: Address
      quote: JupiterQuote
      // Units of the INPUT mint diverted to the tontine inside the same tx
      // (the quote is already computed on the reduced input).
      tontineAmount?: bigint
    }): Promise<Signature> => {
      const feeAccount = feeMint
        ? await ensureTreasuryFeeAccount(client, { mint: feeMint, transactionSigner: await getTransactionSigner() })
        : undefined
      const body = await fetchJupiterBuild({
        amount: BigInt(quote.inAmount),
        destinationTokenAccount,
        feeAccount,
        inputMint: quote.inputMint,
        outputMint: quote.outputMint,
        platformFeeBps: feeAccount ? getFimsPlatformFeeBps() : undefined,
        taker: account.publicKey,
        transactionVersion: getAccountTransactionVersion(account),
      })
      const transactionSigner = await getTransactionSigner()
      const instructions = jupiterInstructions(body)
      if (tontineAmount && tontineAmount > 0n) {
        instructions.push(
          ...(await buildTontineCarveInstructions(client, {
            amount: tontineAmount,
            mint: body.inputMint as Address,
            transactionSigner,
          })),
        )
      }
      const wire = await compileJupiterWire(client, {
        body,
        instructions,
        payer: address(account.publicKey),
      })
      // The output lands in the destination's ATA, not ours — the wallet
      // spends the input mint and receives nothing, so only the spend side
      // is asserted (expectedReceive stays undefined on purpose).
      return signAndSendBase64Transaction(
        wire,
        { amount: BigInt(body.inAmount), mint: body.inputMint as Address },
        undefined,
        tontineAmount ? [{ amount: tontineAmount, mint: body.inputMint as Address }] : undefined,
      )
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
  const client = useSolanaClient({ network })
  const getTransactionSigner = useAccountGetTransactionSigner({ account })
  const signAndSendBase64Transaction = useSignAndSendTransaction({ account, network })

  return useMutation({
    mutationFn: async ({
      feeMint,
      inputMint,
      makingAmount,
      outputMint,
      takingAmount,
    }: {
      feeMint?: Address
      inputMint: string
      makingAmount: bigint
      outputMint: string
      takingAmount: bigint
    }): Promise<Signature> => {
      // feeBps is charged on the taken (output) mint when the order settles —
      // the keeper executes the order without us, so the fee must be encoded
      // in the order itself. The feeAccount is the treasury ATA of the fee
      // mint, created lazily on first use.
      const feeAccount = feeMint
        ? await ensureTreasuryFeeAccount(client, { mint: feeMint, transactionSigner: await getTransactionSigner() })
        : undefined
      const res = await fetch(`${JUPITER_API}/trigger/v1/createOrder`, {
        body: JSON.stringify({
          feeAccount,
          inputMint,
          maker: account.publicKey,
          outputMint,
          params: {
            feeBps: feeMint ? String(getFimsPlatformFeeBps()) : undefined,
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

// On-chain strategy state (delegate + share mints). Drives the "buy FSOL"
// swap route: when the output mint is a strategy share, the swap ends with a
// program deposit instead of a market fill.
export function useFimsStrategyState({ network }: { network: Network }) {
  const client = useSolanaClient({ network })
  return useQuery({
    queryFn: () => fetchStrategyState(client.rpc),
    queryKey: ['fims', 'strategy-state', network.id],
    staleTime: 60_000,
  })
}

export function useFimsStrategySwap({ account, network }: { account: Account; network: Network }) {
  const client = useSolanaClient({ network })
  const getTransactionSigner = useAccountGetTransactionSigner({ account })
  const signAndSendBase64Transaction = useSignAndSendTransaction({ account, network })

  return useMutation({
    mutationFn: async ({
      feeMint,
      quote,
      state,
      strategyIndex,
      tontineAmount,
    }: {
      feeMint?: Address
      quote: JupiterQuote
      state: FimsStrategyState
      strategyIndex: number
      // Units of the INPUT mint diverted to the tontine inside the same tx
      // (the quote is already computed on the reduced input).
      tontineAmount?: bigint
    }): Promise<Signature> => {
      const strategy = state.strategies[strategyIndex]
      if (!strategy) throw new Error(`unknown strategy index ${strategyIndex}`)
      const transactionSigner = await getTransactionSigner()
      const feeAccount = feeMint
        ? await ensureTreasuryFeeAccount(client, { mint: feeMint, transactionSigner })
        : undefined
      const body = await fetchJupiterBuild({
        amount: BigInt(quote.inAmount),
        feeAccount,
        inputMint: quote.inputMint,
        outputMint: quote.outputMint,
        platformFeeBps: feeAccount ? getFimsPlatformFeeBps() : undefined,
        taker: account.publicKey,
        transactionVersion: getAccountTransactionVersion(account),
      })
      const instructions = jupiterInstructions(body)
      // Deposit the quoted amount — the program clamps to what actually
      // arrived so slippage cannot revert the whole transaction.
      instructions.push(
        await buildDepositIx(client.rpc, {
          amount: BigInt(body.outAmount),
          member: account.publicKey as Address,
          state,
          strategyIndex,
        }),
      )
      if (tontineAmount && tontineAmount > 0n) {
        instructions.push(
          ...(await buildTontineCarveInstructions(client, {
            amount: tontineAmount,
            mint: body.inputMint as Address,
            transactionSigner,
          })),
        )
      }
      const wire = await compileJupiterWire(client, {
        body,
        instructions,
        payer: address(account.publicKey),
      })

      // The wallet spends the input mint; the collateral lands in the vault
      // via the deposit ix, so the min-out is asserted on wallet+vault
      // inflow while the member ATA may go net-negative by the slippage gap
      // (a pre-existing balance gets swept into the deposit too).
      return signAndSendBase64Transaction(
        wire,
        { amount: BigInt(body.inAmount), mint: body.inputMint as Address },
        { amount: BigInt(body.otherAmountThreshold), mint: strategy.collateralMint },
        [
          {
            amount: BigInt(body.outAmount) - BigInt(body.otherAmountThreshold),
            mint: strategy.collateralMint,
          },
          // Tip + share ATA rent + member_deposit PDA rent paid by the member.
          { amount: FIMS_STRATEGY_NATIVE_OVERHEAD_LAMPORTS, mint: NATIVE_MINT },
          // The tontine carve is an extra input-mint outflow on top of the
          // swap input.
          ...(tontineAmount ? [{ amount: tontineAmount, mint: body.inputMint as Address }] : []),
        ],
        await vaultPda(),
      )
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
