import {
  type Address,
  type Base64EncodedWireTransaction,
  fetchAddressesForLookupTables,
  getBase64Encoder,
  getCompiledTransactionMessageDecoder,
  getTransactionDecoder,
  type ReadonlyUint8Array,
  type Transaction,
} from '@solana/kit'
import { tryCatch } from '@workspace/core/try-catch'
import { getSimulatedSolBalanceChanges } from './get-simulated-sol-balance-changes.ts'
import {
  getSimulatedTokenAccountStates,
  getSimulatedTokenBalanceChanges,
  type SimulatedTokenAccountState,
} from './get-simulated-token-balance-changes.ts'
import { maybeBigInt } from './parse-rpc-number.ts'
import type {
  RawParsedAccount,
  RawSimulateTransactionValue,
  SimulatePreparedTransactionSolBalanceChange,
  SimulatePreparedTransactionTokenBalanceChange,
} from './simulate-prepared-transaction-types.ts'
import type { SolanaClient } from './solana-client.ts'

export interface WireInstruction {
  accountAddresses: (Address | undefined)[]
  data: ReadonlyUint8Array
  // An account index that does not resolve inside the loaded account list:
  // the instruction's intent cannot be verified and callers must refuse it.
  hasUnresolvedAccounts: boolean
  programId: Address | undefined
}

export interface WireTransactionInspection {
  // Required signers that already carry a non-empty signature in the wire
  // transaction (e.g. Jupiter pre-signs trigger orders with an ephemeral keypair).
  alreadySignedBy: Address[]
  // All instructions' program ids — including those referenced through address
  // lookup tables, which the simulation resolves server-side.
  programIds: Address[]
  // Top-level instructions, decoded far enough for a policy check
  // (program + resolved account addresses + raw discriminator data).
  instructions: WireInstruction[]
  feePayer: Address | undefined
  requiredSigners: Address[]
  simulation: {
    // False when the pre/post account states could not both be fetched:
    // the balance deltas below are then incomplete, and any policy built
    // on them must fail closed instead of silently allowing a drain.
    accountsReliable: boolean
    error: unknown
    fee: bigint | undefined
    logs: string[]
    solBalanceChanges: SimulatePreparedTransactionSolBalanceChange[]
    status: 'failure' | 'success'
    tokenBalanceChanges: SimulatePreparedTransactionTokenBalanceChange[]
    // Per-token-account ownership/delegation/destruction state: the
    // security holes a pure balance diff cannot see (SetAuthority,
    // Approve delegates, closed accounts).
    tokenAccounts: SimulatedTokenAccountState[]
    // Program owner of the fee payer account after the transaction — a
    // System-program Assign would silently hand the whole wallet over.
    walletOwnerAfter: Address | undefined
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
      // Fail closed: a skipped index would shift the resolved account
      // list and let an instruction hide behind a wrong program id.
      if (!resolved) {
        throw new Error(`lookup table ${lookup.lookupTableAddress} has no writable index ${index}`)
      }
      loadedWritable.push(resolved)
    }
    for (const index of lookup.readonlyIndexes) {
      const resolved = table[index]
      if (!resolved) {
        throw new Error(`lookup table ${lookup.lookupTableAddress} has no readonly index ${index}`)
      }
      loadedReadonly.push(resolved)
    }
  }
  const allAccounts = [...staticAccounts, ...loadedWritable, ...loadedReadonly]

  const instructions =
    message.version === 'legacy' || message.version === 0
      ? message.instructions.map((ix) => ({
          accountIndices: ix.accountIndices ?? [],
          data: ix.data ?? new Uint8Array(),
          programAddressIndex: ix.programAddressIndex,
        }))
      : // v1 splits each instruction: `instructionHeaders[i]` carries the
        // program index, `instructionPayloads[i]` the account indices and the
        // data — named `instructionData`, NOT `data`. Reading `payload.data`
        // silently empties every instruction and disables all
        // instruction-level guards.
        message.instructionPayloads.map((payload, index) => ({
          // `?? []` like the legacy branch — a missing field must not throw,
          // the empty index list fails closed via hasUnresolvedAccounts.
          accountIndices: payload.instructionAccountIndices ?? [],
          data: payload.instructionData ?? new Uint8Array(),
          // A missing header must not resolve to account 0: point the
          // program index outside the loaded list so the instruction
          // reports hasUnresolvedAccounts and every caller fails closed.
          programAddressIndex: message.instructionHeaders[index]?.programAccountIndex ?? allAccounts.length,
        }))

  const programIds = [...new Set(instructions.map((ix) => allAccounts[ix.programAddressIndex]).filter(Boolean))]

  const wireInstructions: WireInstruction[] = instructions.map((ix) => ({
    accountAddresses: ix.accountIndices.map((index) => allAccounts[index]),
    data: ix.data,
    hasUnresolvedAccounts:
      ix.accountIndices.some((index) => allAccounts[index] === undefined) ||
      allAccounts[ix.programAddressIndex] === undefined,
    programId: allAccounts[ix.programAddressIndex],
  }))

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
  // Fail-closed coverage check: every position of the loaded account list
  // needs both a pre-state (getMultipleAccounts) and a post-state (the
  // simulation's `accounts` reply) for the deltas below to be complete.
  // A rate-limited or truncated RPC must NOT silently degrade the policy
  // to "no changes detected".
  const accountsReliable =
    !preAccountsResult.error &&
    preAccounts.length === allAccounts.length &&
    Array.isArray(value.accounts) &&
    value.accounts.length === allAccounts.length

  return {
    alreadySignedBy,
    feePayer,
    instructions: wireInstructions,
    programIds: programIds.filter((id): id is Address => id !== undefined),
    requiredSigners,
    simulation: {
      accountsReliable,
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
      tokenAccounts: getSimulatedTokenAccountStates({
        accountAddresses: allAccounts,
        postAccounts,
        preAccounts,
      }),
      tokenBalanceChanges: getSimulatedTokenBalanceChanges({
        accountAddresses: allAccounts,
        postAccounts,
        postTokenBalances: value.postTokenBalances,
        preAccounts,
        preTokenBalances: value.preTokenBalances,
      }),
      unitsConsumed: maybeBigInt(value.unitsConsumed),
      walletOwnerAfter: postAccounts?.[0]?.owner,
    },
  }
}
