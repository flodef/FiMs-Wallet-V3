// Jupiter /swap/v2 wire format: response schemas and the helpers that turn a
// build result into kit instructions and a compiled wire transaction.
// Pure wire handling — no React, no hooks.
import type { Address, Blockhash } from '@solana/kit'
import {
  AccountRole,
  address,
  appendTransactionMessageInstructions,
  compileTransaction,
  compressTransactionMessageUsingAddressLookupTables,
  createTransactionMessage,
  estimateAndSetResourceLimitsFactory,
  estimateResourceLimitsFactory,
  getBase58Decoder,
  getBase64EncodedWireTransaction,
  getBase64Encoder,
  getTransactionMessageComputeUnitLimit,
  type Instruction,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  setTransactionMessagePriorityFeeLamports,
} from '@solana/kit'
import type { SolanaClient } from '@workspace/solana-client/solana-client'
import { z } from 'zod'

export const jupiterInstructionSchema = z.object({
  accounts: z.array(z.object({ isSigner: z.boolean(), isWritable: z.boolean(), pubkey: z.string() })),
  data: z.string(),
  programId: z.string(),
})

export const jupiterBuildSchema = z
  .object({
    addressesByLookupTableAddress: z.record(z.string(), z.array(z.string())).nullish(),
    blockhashWithMetadata: z.object({
      blockhash: z.array(z.number()),
      lastValidBlockHeight: z.number(),
    }),
    cleanupInstruction: jupiterInstructionSchema.nullish(),
    computeBudgetInstructions: z.array(jupiterInstructionSchema).optional(),
    computeUnitPrice: z.string().optional(),
    inAmount: z.string(),
    inputMint: z.string(),
    otherAmountThreshold: z.string(),
    otherInstructions: z.array(jupiterInstructionSchema).optional(),
    outAmount: z.string(),
    outputMint: z.string(),
    priceImpactPct: z.string().optional(),
    setupInstructions: z.array(jupiterInstructionSchema).optional(),
    swapInstruction: jupiterInstructionSchema,
    swapMode: z.string().optional(),
    tipInstruction: jupiterInstructionSchema.nullish(),
    transactionVersion: z.union([z.literal(0), z.literal(1)]),
  })
  .passthrough()

// The /build response doubles as the quote: the fields the UI displays
// (outAmount, otherAmountThreshold, priceImpactPct) are all on it.
export type JupiterBuild = z.infer<typeof jupiterBuildSchema>
export type JupiterQuote = JupiterBuild
export type JupiterInstruction = z.infer<typeof jupiterInstructionSchema>

// Jupiter's instruction list, in its documented order, mapped to kit
// instructions — ready for appending our own (deposit, tontine carve).
export function jupiterInstructions(body: JupiterBuild): Instruction[] {
  return [
    ...(body.computeBudgetInstructions ?? []),
    ...(body.setupInstructions ?? []),
    body.swapInstruction,
    ...(body.cleanupInstruction ? [body.cleanupInstruction] : []),
    ...(body.otherInstructions ?? []),
    ...(body.tipInstruction ? [body.tipInstruction] : []),
  ].map(toKitIx)
}

// Compile the composed instruction list into a base64 wire transaction at the
// version /build returned. v0 compresses against the response's resolved
// lookup tables; v1 inlines every account. Both paths get their compute-unit
// limit from a simulation (v1 also requires loadedAccountsDataSizeLimit in
// its config — an unset field means zero budget and a failed transaction).
export async function compileJupiterWire(
  client: SolanaClient,
  { body, instructions, payer }: { body: JupiterBuild; instructions: Instruction[]; payer: Address },
): Promise<string> {
  const latestBlockhash = {
    blockhash: getBase58Decoder().decode(Uint8Array.from(body.blockhashWithMetadata.blockhash)) as Blockhash,
    lastValidBlockHeight: BigInt(body.blockhashWithMetadata.lastValidBlockHeight),
  }
  const estimateAndSet = estimateAndSetResourceLimitsFactory(estimateResourceLimitsFactory({ rpc: client.rpc }))
  if (body.transactionVersion === 1) {
    // v1 inlines every account — nothing to resolve — but the resource
    // limits must live in the message config or the transaction fails.
    let message = pipe(
      createTransactionMessage({ version: 1 }),
      (tx) => setTransactionMessageFeePayer(payer, tx),
      (tx) => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, tx),
      (tx) => appendTransactionMessageInstructions(instructions, tx),
    )
    message = await estimateAndSet(message)
    if (body.computeUnitPrice) {
      // v1 carries a total priority fee, not a per-CU price: convert
      // Jupiter's suggested micro-lamport rate against the simulated limit.
      const cuLimit = getTransactionMessageComputeUnitLimit(message) ?? 0
      const lamports = BigInt(Math.ceil((Number(body.computeUnitPrice) * cuLimit) / 1_000_000))
      message = setTransactionMessagePriorityFeeLamports(lamports, message)
    }
    return getBase64EncodedWireTransaction(compileTransaction(message))
  }
  // v0 compresses against the resolved lookup tables the response carries.
  let message = pipe(
    createTransactionMessage({ version: 0 }),
    (tx) => setTransactionMessageFeePayer(payer, tx),
    (tx) => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, tx),
    (tx) => appendTransactionMessageInstructions(instructions, tx),
  )
  if (body.addressesByLookupTableAddress) {
    message = compressTransactionMessageUsingAddressLookupTables(
      message,
      Object.fromEntries(
        Object.entries(body.addressesByLookupTableAddress).map(([table, addresses]) => [
          table as Address,
          addresses.map((a) => address(a)),
        ]),
      ),
    )
  }
  message = await estimateAndSet(message)
  return getBase64EncodedWireTransaction(compileTransaction(message))
}

export function toKitIx(ix: JupiterInstruction): Instruction {
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
