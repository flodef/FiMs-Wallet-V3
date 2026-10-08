import type { Address, TransactionSigner } from '@solana/kit'
import {
  AccountRole,
  address,
  appendTransactionMessageInstructions,
  compileTransaction,
  compressTransactionMessageUsingAddressLookupTables,
  createTransactionMessage,
  fetchAddressesForLookupTables,
  getBase64EncodedWireTransaction,
  getBase64Encoder,
  getSignatureFromTransaction,
  getTransactionDecoder,
  type Instruction,
  pipe,
  type Signature,
  sendTransactionWithoutConfirmingFactory,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionWithSigners,
} from '@solana/kit'
import { fetchMint } from '@solana-program/token'
import { useMutation, useQuery } from '@tanstack/react-query'
import type { Account } from '@workspace/db/account/account'
import type { Network } from '@workspace/db/network/network'
import { useAccountGetTransactionSigner } from '@workspace/db-react/use-account-get-transaction-signer'
import { useAccountSecretKey } from '@workspace/db-react/use-account-secret-key'
import { createKeyPairSignerFromJson } from '@workspace/keypair/create-key-pair-signer-from-json'
import { NATIVE_MINT } from '@workspace/solana-client/constants'
import { createTransferInstructionsSol } from '@workspace/solana-client/create-transfer-instructions-sol'
import { createTransferInstructionsSpl } from '@workspace/solana-client/create-transfer-instructions-spl'
import { inspectWireTransaction } from '@workspace/solana-client/inspect-wire-transaction'
import type { SolanaClient } from '@workspace/solana-client/solana-client'
import { useSolanaClient } from '@workspace/solana-client-react/use-solana-client'
import { useCallback } from 'react'
import { z } from 'zod'
import { FIMS_TONTINE_ADDRESS } from '../fims-constants.ts'
import { getFimsPlatformFeeBps } from '../fims-fee-config.ts'
import { ensureTreasuryFeeAccount } from './ensure-treasury-fee-account.ts'
import {
  buildDepositIx,
  FIMS_STRATEGY_NATIVE_OVERHEAD_LAMPORTS,
  type FimsStrategyState,
  fetchStrategyState,
  vaultPda,
} from './fims-strategy.ts'
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

const jupiterQuoteSchema = z
  .object({
    inAmount: z.string(),
    inputMint: z.string(),
    otherAmountThreshold: z.string(),
    outAmount: z.string(),
    outputMint: z.string(),
    priceImpactPct: z.string().optional(),
    swapMode: z.string().optional(),
  })
  .passthrough()

export type JupiterQuote = z.infer<typeof jupiterQuoteSchema>

export function useJupiterQuote({
  amount,
  inputMint,
  outputMint,
  platformFeeBps,
  slippageBps = 50,
  swapMode,
}: {
  amount: bigint
  inputMint: string | undefined
  outputMint: string | undefined
  platformFeeBps?: number
  slippageBps?: number
  swapMode?: 'ExactIn' | 'ExactOut'
}) {
  return useQuery({
    enabled: !!inputMint && !!outputMint && inputMint !== outputMint && amount > 0n,
    queryFn: async (): Promise<JupiterQuote> => {
      const url = new URL(`${JUPITER_API}/swap/v1/quote`)
      url.searchParams.set('inputMint', inputMint ?? '')
      url.searchParams.set('outputMint', outputMint ?? '')
      url.searchParams.set('amount', String(amount))
      url.searchParams.set('slippageBps', String(slippageBps))
      if (swapMode) {
        url.searchParams.set('swapMode', swapMode)
      }
      if (platformFeeBps) {
        url.searchParams.set('platformFeeBps', String(platformFeeBps))
      }
      const res = await fetch(url)
      if (!res.ok) {
        throw new Error(`Jupiter quote failed: ${res.status}`)
      }
      return jupiterQuoteSchema.parse(await res.json())
    },
    queryKey: ['fims', 'jupiter-quote', inputMint, outputMint, String(amount), slippageBps, swapMode, platformFeeBps],
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
      // When the quote carries platformFeeBps, /swap requires feeAccount: an
      // initialized ATA of the fee mint owned by the treasury, created lazily
      // on first use (user pays the one-time rent).
      const feeAccount = feeMint
        ? await ensureTreasuryFeeAccount(client, { mint: feeMint, transactionSigner: await getTransactionSigner() })
        : undefined
      // ExactOut quotes flip the meaning of otherAmountThreshold: it is the
      // max input, not the min output. Assert the right side either way.
      const isExactOut = quote.swapMode === 'ExactOut'
      const expectedSpend = {
        amount: BigInt(isExactOut ? quote.otherAmountThreshold : quote.inAmount),
        mint: quote.inputMint as Address,
      }
      const expectedReceive = {
        amount: BigInt(isExactOut ? quote.outAmount : quote.otherAmountThreshold),
        mint: quote.outputMint as Address,
      }
      const extraSpends = tontineAmount ? [{ amount: tontineAmount, mint: quote.inputMint as Address }] : undefined

      if (tontineAmount && tontineAmount > 0n) {
        // The tontine transfer must ride the same transaction — /swap returns
        // a sealed wire transaction, so the carve path composes the tx from
        // /swap-instructions and appends the pot transfer itself.
        const res = await fetch(`${JUPITER_API}/swap/v1/swap-instructions`, {
          body: JSON.stringify({
            dynamicComputeUnitLimit: true,
            feeAccount,
            prioritizationFeeLamports: 'auto',
            quoteResponse: quote,
            userPublicKey: account.publicKey,
            wrapAndUnwrapSol: true,
          }),
          headers: { 'content-type': 'application/json' },
          method: 'POST',
        })
        if (!res.ok) {
          throw new Error(`Jupiter swap-instructions failed: ${res.status}`)
        }
        const body = swapInstructionsSchema.parse(await res.json())
        const transactionSigner = await getTransactionSigner()
        const instructions = raiseComputeUnitLimit(
          jupiterInstructions(body).concat(
            await buildTontineCarveInstructions(client, {
              amount: tontineAmount,
              mint: quote.inputMint as Address,
              transactionSigner,
            }),
          ),
        )
        const wire = await compileSwapWire(client, {
          instructions,
          lookupTableAddresses: body.addressLookupTableAddresses,
          payer: address(account.publicKey),
        })
        return signAndSendBase64Transaction(wire, expectedSpend, expectedReceive, extraSpends)
      }

      const res = await fetch(`${JUPITER_API}/swap/v1/swap`, {
        body: JSON.stringify({
          dynamicComputeUnitLimit: true,
          feeAccount,
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
      return signAndSendBase64Transaction(swapTransaction, expectedSpend, expectedReceive, extraSpends)
    },
  })
}

// Swap whose output mint is delivered straight into somebody else's token
// account (exchange / Jupiter Spend deposit). Jupiter builds a single
// transaction containing the swap plus the transfer — and the ATA creation
// for the destination when needed — so the user signs once.
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
      // Fee mint of a quote carrying platformFeeBps — Jupiter requires the
      // treasury ATA, created lazily on first use (member pays the rent).
      feeMint?: Address
      quote: JupiterQuote
      // Units of the INPUT mint diverted to the tontine before the swap
      // (the quote is already computed on the reduced input).
      tontineAmount?: bigint
    }): Promise<Signature> => {
      const feeAccount = feeMint
        ? await ensureTreasuryFeeAccount(client, { mint: feeMint, transactionSigner: await getTransactionSigner() })
        : undefined
      if (tontineAmount && tontineAmount > 0n) {
        // The carve is its own transaction: /swap-instructions does not
        // guarantee destinationTokenAccount routing, so the pot transfer is
        // signed separately and sent first — the member signs twice.
        const transactionSigner = await getTransactionSigner()
        const instructions = await buildTontineCarveInstructions(client, {
          amount: tontineAmount,
          mint: quote.inputMint as Address,
          transactionSigner,
        })
        const wire = await compileSwapWire(client, {
          instructions,
          payer: address(account.publicKey),
        })
        await signAndSendBase64Transaction(wire, {
          amount: tontineAmount,
          mint: quote.inputMint as Address,
        })
      }
      const res = await fetch(`${JUPITER_API}/swap/v1/swap`, {
        body: JSON.stringify({
          destinationTokenAccount,
          dynamicComputeUnitLimit: true,
          feeAccount,
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

const swapInstructionsSchema = z.object({
  addressLookupTableAddresses: z.array(z.string()).optional(),
  cleanupInstruction: z
    .object({
      accounts: z.array(z.object({ isSigner: z.boolean(), isWritable: z.boolean(), pubkey: z.string() })),
      data: z.string(),
      programId: z.string(),
    })
    .optional(),
  computeBudgetInstructions: z
    .array(
      z.object({
        accounts: z.array(z.object({ isSigner: z.boolean(), isWritable: z.boolean(), pubkey: z.string() })),
        data: z.string(),
        programId: z.string(),
      }),
    )
    .optional(),
  otherInstructions: z
    .array(
      z.object({
        accounts: z.array(z.object({ isSigner: z.boolean(), isWritable: z.boolean(), pubkey: z.string() })),
        data: z.string(),
        programId: z.string(),
      }),
    )
    .optional(),
  setupInstructions: z
    .array(
      z.object({
        accounts: z.array(z.object({ isSigner: z.boolean(), isWritable: z.boolean(), pubkey: z.string() })),
        data: z.string(),
        programId: z.string(),
      }),
    )
    .optional(),
  swapInstruction: z.object({
    accounts: z.array(z.object({ isSigner: z.boolean(), isWritable: z.boolean(), pubkey: z.string() })),
    data: z.string(),
    programId: z.string(),
  }),
})
type SwapInstruction = z.infer<typeof swapInstructionsSchema>['swapInstruction']

const COMPUTE_BUDGET_PROGRAM = 'ComputeBudget111111111111111111111111111111'
// Extra instructions appended after Jupiter's own (strategy deposit, tontine
// carve) are not covered by dynamicComputeUnitLimit — raise the cap so the
// added transfers + ATA creations cannot run the transaction dry.
const STRATEGY_DEPOSIT_EXTRA_CU = 150_000

// ComputeBudget::SetComputeUnitLimit carries a u32 at byte 1.
function raiseComputeUnitLimit(ixs: Instruction[]): Instruction[] {
  const idx = ixs.findIndex(
    (ix) => ix.programAddress === COMPUTE_BUDGET_PROGRAM && ix.data?.[0] === 2 && (ix.data?.length ?? 0) >= 5,
  )
  if (idx < 0) {
    const data = new Uint8Array(5)
    data[0] = 2
    new DataView(data.buffer).setUint32(1, STRATEGY_DEPOSIT_EXTRA_CU, true)
    return [{ accounts: [], data, programAddress: address(COMPUTE_BUDGET_PROGRAM) }, ...ixs]
  }
  return ixs.map((ix, i) => {
    if (i !== idx || !ix.data) return ix
    const data = new Uint8Array(ix.data)
    const view = new DataView(data.buffer)
    view.setUint32(1, view.getUint32(1, true) + STRATEGY_DEPOSIT_EXTRA_CU, true)
    return { ...ix, data }
  })
}

// Jupiter's instruction list, in its documented order, mapped to kit
// instructions — ready for appending our own (deposit, tontine carve).
function jupiterInstructions(body: z.infer<typeof swapInstructionsSchema>): Instruction[] {
  return [
    ...(body.computeBudgetInstructions ?? []),
    ...(body.setupInstructions ?? []),
    body.swapInstruction,
    ...(body.cleanupInstruction ? [body.cleanupInstruction] : []),
    ...(body.otherInstructions ?? []),
  ].map(toKitIx)
}

// Compile the composed instruction list into a base64 wire transaction:
// fresh blockhash, the member as fee payer, ALTs from the Jupiter response.
async function compileSwapWire(
  client: SolanaClient,
  {
    instructions,
    lookupTableAddresses,
    payer,
  }: { instructions: Instruction[]; lookupTableAddresses?: string[] | undefined; payer: Address },
): Promise<string> {
  const { value: latestBlockhash } = await client.rpc.getLatestBlockhash().send()
  const lookupTables = lookupTableAddresses?.length
    ? await fetchAddressesForLookupTables(
        lookupTableAddresses.map((a) => address(a)),
        client.rpc,
      )
    : undefined
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (tx) => setTransactionMessageFeePayer(payer, tx),
    (tx) => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, tx),
    (tx) => appendTransactionMessageInstructions(instructions, tx),
    (tx) => (lookupTables ? compressTransactionMessageUsingAddressLookupTables(tx, lookupTables) : tx),
  )
  return getBase64EncodedWireTransaction(compileTransaction(message))
}

function toKitIx(ix: SwapInstruction): Instruction {
  return {
    accounts: ix.accounts.map((account) => ({
      address: address(account.pubkey),
      role: account.isSigner
        ? account.isWritable
          ? AccountRole.WRITABLE_SIGNER
          : AccountRole.READONLY_SIGNER
        : account.isWritable
          ? AccountRole.WRITABLE
          : AccountRole.READONLY,
    })),
    data: getBase64Encoder().encode(ix.data),
    programAddress: address(ix.programId),
  }
}

// Buy a strategy share token (FSOL, FLiP): Jupiter swaps the input into the
// strategy collateral (JUPSOL…) and the same transaction ends with the
// program `deposit` — collateral lands in the vault, the member's share ATA
// is created, the delegate gets its tip. The keeper then issues the shares
// 1:1 within ~a minute; the member never holds the collateral.
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
      const res = await fetch(`${JUPITER_API}/swap/v1/swap-instructions`, {
        body: JSON.stringify({
          dynamicComputeUnitLimit: true,
          feeAccount,
          quoteResponse: quote,
          userPublicKey: account.publicKey,
          wrapAndUnwrapSol: true,
        }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      })
      if (!res.ok) {
        throw new Error(`Jupiter swap-instructions failed: ${res.status}`)
      }
      const body = swapInstructionsSchema.parse(await res.json())
      const instructions = raiseComputeUnitLimit(jupiterInstructions(body))
      // Deposit the quoted amount — the program clamps to what actually
      // arrived so slippage cannot revert the whole transaction.
      instructions.push(
        await buildDepositIx(client.rpc, {
          amount: BigInt(quote.outAmount),
          member: account.publicKey as Address,
          state,
          strategyIndex,
        }),
      )
      if (tontineAmount && tontineAmount > 0n) {
        instructions.push(
          ...(await buildTontineCarveInstructions(client, {
            amount: tontineAmount,
            mint: quote.inputMint as Address,
            transactionSigner,
          })),
        )
      }
      const wire = await compileSwapWire(client, {
        instructions,
        lookupTableAddresses: body.addressLookupTableAddresses,
        payer: address(account.publicKey),
      })

      // The wallet spends the input mint; the collateral lands in the vault
      // via the deposit ix, so the min-out is asserted on wallet+vault
      // inflow while the member ATA may go net-negative by the slippage gap
      // (a pre-existing balance gets swept into the deposit too).
      return signAndSendBase64Transaction(
        wire,
        { amount: BigInt(quote.inAmount), mint: quote.inputMint as Address },
        { amount: BigInt(quote.otherAmountThreshold), mint: strategy.collateralMint },
        [
          {
            amount: BigInt(quote.outAmount) - BigInt(quote.otherAmountThreshold),
            mint: strategy.collateralMint,
          },
          // Tip + share ATA rent + member_deposit PDA rent paid by the member.
          { amount: FIMS_STRATEGY_NATIVE_OVERHEAD_LAMPORTS, mint: NATIVE_MINT },
          // The tontine carve is an extra input-mint outflow on top of the
          // swap input.
          ...(tontineAmount ? [{ amount: tontineAmount, mint: quote.inputMint as Address }] : []),
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
