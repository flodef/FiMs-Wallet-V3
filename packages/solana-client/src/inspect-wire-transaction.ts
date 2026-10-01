import {
  type Address,
  type Base64EncodedWireTransaction,
  fetchAddressesForLookupTables,
  getBase64Encoder,
  getCompiledTransactionMessageDecoder,
  getTransactionDecoder,
  type Transaction,
} from '@solana/kit'
import { tryCatch } from '@workspace/core/try-catch'
import { getSimulatedSolBalanceChanges } from './get-simulated-sol-balance-changes.ts'
import { getSimulatedTokenBalanceChanges } from './get-simulated-token-balance-changes.ts'
import { maybeBigInt } from './parse-rpc-number.ts'
import type {
  RawParsedAccount,
  RawSimulateTransactionValue,
  SimulatePreparedTransactionSolBalanceChange,
  SimulatePreparedTransactionTokenBalanceChange,
} from './simulate-prepared-transaction-types.ts'
import type { SolanaClient } from './solana-client.ts'

export interface WireTransactionInspection {
  // Required signers that already carry a non-empty signature in the wire
  // transaction (e.g. Jupiter pre-signs trigger orders with an ephemeral keypair).
  alreadySignedBy: Address[]
  // All instructions' program ids — including those referenced through address
  // lookup tables, which the simulation resolves server-side.
  programIds: Address[]
  feePayer: Address | undefined
  requiredSigners: Address[]
  simulation: {
    error: unknown
    fee: bigint | undefined
    logs: string[]
    solBalanceChanges: SimulatePreparedTransactionSolBalanceChange[]
    status: 'failure' | 'success'
    tokenBalanceChanges: SimulatePreparedTransactionTokenBalanceChange[]
    unitsConsumed: bigint | undefined
  }
}

// Decodes an already-compiled wire transaction (e.g. a Jupiter swap), resolves
// its address lookup tables so program ids behind lookups are visible, and
// simulates it to expose per-account balance changes — all before signing.
export async function inspectWireTransaction(
  client: SolanaClient,
  base64Transaction: string,
): Promise<WireTransactionInspection> {
  const transaction = getTransactionDecoder().decode(
    getBase64Encoder().encode(base64Transaction) as Uint8Array,
  ) as Transaction
  const message = getCompiledTransactionMessageDecoder().decode(transaction.messageBytes as unknown as Uint8Array)

  const staticAccounts = [...message.staticAccounts]
  const feePayer = staticAccounts[0]
  const requiredSigners = staticAccounts.slice(0, message.header.numSignerAccounts)
  const signatures = (transaction as { signatures?: Record<string, Uint8Array> }).signatures ?? {}
  const alreadySignedBy = requiredSigners.filter((signer) => {
    const signature = signatures[signer]
    return signature instanceof Uint8Array && signature.some((byte) => byte !== 0)
  })

  const lookups = 'addressTableLookups' in message ? (message.addressTableLookups ?? []) : []
  const addressesByLookup = lookups.length
    ? await fetchAddressesForLookupTables(
        lookups.map((lookup) => lookup.lookupTableAddress),
        client.rpc,
      )
    : {}

  // Resolved account list in message order: static, then writable lookups,
  // then readonly lookups (per Solana's compiled-message layout).
  const loadedWritable: Address[] = []
  const loadedReadonly: Address[] = []
  for (const lookup of lookups) {
    const table = addressesByLookup[lookup.lookupTableAddress] ?? []
    for (const index of lookup.writableIndexes) {
      const resolved = table[index]
      if (resolved) loadedWritable.push(resolved)
    }
    for (const index of lookup.readonlyIndexes) {
      const resolved = table[index]
      if (resolved) loadedReadonly.push(resolved)
    }
  }
  const allAccounts = [...staticAccounts, ...loadedWritable, ...loadedReadonly]

  const instructions =
    message.version === 'legacy' || message.version === 0
      ? (message as { instructions: { accountIndices: readonly number[]; programAddressIndex: number }[] }).instructions
      : (
          message as unknown as { instructionPayloads: { instructionAccountIndices: readonly number[] }[] }
        ).instructionPayloads.map((payload, index) => ({
          accountIndices: payload.instructionAccountIndices,
          programAddressIndex:
            (message as unknown as { instructionHeaders: { programAccountIndex: number }[] }).instructionHeaders[index]
              ?.programAccountIndex ?? 0,
        }))

  const programIds = [...new Set(instructions.map((ix) => allAccounts[ix.programAddressIndex]).filter(Boolean))]

  const [preAccountsResult, response] = await Promise.all([
    tryCatch(client.rpc.getMultipleAccounts(allAccounts, { commitment: 'confirmed', encoding: 'base64' }).send()),
    client.rpc
      .simulateTransaction(base64Transaction as Base64EncodedWireTransaction, {
        accounts: { addresses: allAccounts, encoding: 'base64' },
        commitment: 'confirmed',
        encoding: 'base64',
        innerInstructions: true,
        replaceRecentBlockhash: true,
        sigVerify: false,
      })
      .send(),
  ])

  const value = response.value as RawSimulateTransactionValue
  const preAccounts = preAccountsResult.error
    ? []
    : ((preAccountsResult.data?.value ?? []) as (RawParsedAccount | null)[])
  const postAccounts = preAccountsResult.error ? undefined : value.accounts

  return {
    alreadySignedBy,
    feePayer,
    programIds: programIds.filter((id): id is Address => id !== undefined),
    requiredSigners,
    simulation: {
      error: value.err ?? null,
      fee: maybeBigInt(value.fee),
      logs: value.logs ?? [],
      solBalanceChanges: getSimulatedSolBalanceChanges({
        accountAddresses: allAccounts,
        postAccounts,
        postBalances: value.postBalances,
        preAccounts,
        preBalances: value.preBalances,
      }),
      status: value.err ? 'failure' : 'success',
      tokenBalanceChanges: getSimulatedTokenBalanceChanges({
        accountAddresses: allAccounts,
        postAccounts,
        postTokenBalances: value.postTokenBalances,
        preAccounts,
        preTokenBalances: value.preTokenBalances,
      }),
      unitsConsumed: maybeBigInt(value.unitsConsumed),
    },
  }
}
