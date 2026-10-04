import {
  type Address,
  assertIsAddress,
  assertIsTransactionSigner,
  type Instruction,
  type TransactionSigner,
} from '@solana/kit'
import { getTransferSolInstruction } from '@solana-program/system'
import { findAssociatedTokenPda, getTransferCheckedInstruction } from '@solana-program/token'
import { getCloseAccountInstruction, getCreateAssociatedTokenIdempotentInstruction } from '@solana-program/token-2022'
import { TOKEN_2022_PROGRAM_ADDRESS, TOKEN_PROGRAM_ADDRESS, TRANSACTION_FEE_LAMPORTS } from './constants.ts'
import { getBalance } from './get-balance.ts'
import { getTokenAccountsForProgramId, type TokenAccountsByOwnerAccount } from './get-token-accounts-for-program-id.ts'
import type { SolanaClient } from './solana-client.ts'

export interface WalletMigrationTokenAccount {
  ata: Address
  balance: bigint
  decimals: number
  // Lamports held by the token account — recovered by the destination on close.
  lamports: bigint
  mint: Address
  tokenProgram: Address
}

export interface WalletMigrationPlan {
  // Ordered instruction batches — execute sequentially, simulating each.
  batches: Instruction[][]
  // Source token accounts that already had a zero balance (close only).
  closedEmptyAccounts: number
  // Estimated rent the source pays to create destination ATAs.
  estimatedNewAtaRent: bigint
  // Everything the migration recovers or moves, in lamports.
  insufficientSolForFees: boolean
  movedAssets: WalletMigrationTokenAccount[]
  newAtaCount: number
  rentToDestination: bigint
  solToSweep: bigint
  txFeeTotal: bigint
}

// Conservative instruction cap per batch — a batch with ATA creates,
// transfers and closes stays well under the 1232-byte wire limit and the
// default compute budget. Every batch is simulated before sending, so an
// oversized batch would surface as a simulation failure, not a stuck tx.
const MAX_INSTRUCTIONS_PER_BATCH = 12

// Kept behind for the last batch's fee plus a safety buffer — the sweep
// drains whatever is left after every batch's network fee is paid.
const SOL_SAFETY_BUFFER_LAMPORTS = BigInt(20_000)

// Split items into batches capped by total instruction weight, preserving
// order. Exported for unit tests.
export function splitIntoBatches<T>(items: T[], weight: (item: T) => number, maxWeight: number): T[][] {
  const batches: T[][] = []
  let current: T[] = []
  let currentWeight = 0
  for (const item of items) {
    const itemWeight = weight(item)
    if (current.length && currentWeight + itemWeight > maxWeight) {
      batches.push(current)
      current = []
      currentWeight = 0
    }
    current.push(item)
    currentWeight += itemWeight
  }
  if (current.length) {
    batches.push(current)
  }
  return batches
}

// The final transaction sweeps whatever SOL is left once every batch's fee
// is accounted for — the source pays each fee along the way, so reserving
// one fee per batch upfront is exact (plus a small buffer).
export function computeSolSweep(solBalance: bigint, txCount: number): { sufficient: boolean; sweep: bigint } {
  const reserve = TRANSACTION_FEE_LAMPORTS * BigInt(txCount) + SOL_SAFETY_BUFFER_LAMPORTS
  const sweep = solBalance - reserve
  return { sufficient: sweep > 0n, sweep: sweep > 0n ? sweep : 0n }
}

function flattenTokenAccounts(results: TokenAccountsByOwnerAccount[]): WalletMigrationTokenAccount[] {
  return results.flatMap((entry) => {
    const info = entry.account.data.parsed.info
    return [
      {
        ata: entry.pubkey,
        balance: BigInt(info.tokenAmount.amount),
        decimals: info.tokenAmount.decimals,
        lamports: entry.account.lamports,
        mint: info.mint,
        tokenProgram: entry.account.owner,
      },
    ]
  })
}

// Builds the full migration: every SPL/Token-2022 account is transferred to
// the destination ATA (created when missing), then closed so its rent lands
// directly in the new wallet; the last batch sweeps the remaining SOL minus
// the reserve covering every batch's network fee.
//
// Nothing is sent here — callers preview the estimate, then execute the
// batches one by one (simulated first). Old accounts are only closed inside
// the same transaction that moves their balance, so a failed batch never
// strands funds: the worst case is a partially migrated wallet that can be
// re-planned and retried.
export async function planWalletMigration(
  client: SolanaClient,
  { destination, source }: { destination: Address; source: TransactionSigner },
): Promise<WalletMigrationPlan> {
  assertIsAddress(destination)
  assertIsTransactionSigner(source)

  const [solBalanceResult, tokenAccounts, token2022Accounts, destinationAccounts, destination2022Accounts, rent] =
    await Promise.all([
      getBalance(client, { address: source.address }),
      getTokenAccountsForProgramId(client, { address: source.address, programId: TOKEN_PROGRAM_ADDRESS }),
      getTokenAccountsForProgramId(client, { address: source.address, programId: TOKEN_2022_PROGRAM_ADDRESS }),
      getTokenAccountsForProgramId(client, { address: destination, programId: TOKEN_PROGRAM_ADDRESS }),
      getTokenAccountsForProgramId(client, { address: destination, programId: TOKEN_2022_PROGRAM_ADDRESS }),
      // Token accounts are 165 bytes; the exact size for Token-2022 ATAs is
      // mint-dependent, so this is the lower bound shown as an estimate.
      client.rpc.getMinimumBalanceForRentExemption(165n).send(),
    ])
  const solBalance = solBalanceResult.value

  const sources = flattenTokenAccounts([...tokenAccounts.value, ...token2022Accounts.value])
  const destinationMints = new Set(
    flattenTokenAccounts([...destinationAccounts.value, ...destination2022Accounts.value]).map(
      (account) => `${account.tokenProgram}:${account.mint}`,
    ),
  )

  interface MigrationUnit {
    account: WalletMigrationTokenAccount
    instructions: Instruction[]
    needsNewAta: boolean
  }

  const units: MigrationUnit[] = []
  for (const account of sources) {
    const instructions: Instruction[] = []
    const [destinationAta] = await findAssociatedTokenPda({
      mint: account.mint,
      owner: destination,
      tokenProgram: account.tokenProgram,
    })

    let needsNewAta = false
    if (account.balance > 0n) {
      needsNewAta = !destinationMints.has(`${account.tokenProgram}:${account.mint}`)
      if (needsNewAta) {
        instructions.push(
          getCreateAssociatedTokenIdempotentInstruction({
            ata: destinationAta,
            mint: account.mint,
            owner: destination,
            payer: source,
            tokenProgram: account.tokenProgram,
          }),
        )
      }
      instructions.push(
        getTransferCheckedInstruction(
          {
            amount: account.balance,
            authority: source,
            decimals: account.decimals,
            destination: destinationAta,
            mint: account.mint,
            source: account.ata,
          },
          { programAddress: account.tokenProgram },
        ),
      )
    }
    // Rent goes straight to the new wallet — it seeds it enough to interact
    // before the SOL sweep lands.
    instructions.push(
      getCloseAccountInstruction(
        { account: account.ata, destination, owner: source },
        { programAddress: account.tokenProgram },
      ),
    )
    units.push({ account, instructions, needsNewAta })
  }

  const batches = splitIntoBatches(units, (unit) => unit.instructions.length, MAX_INSTRUCTIONS_PER_BATCH).map((batch) =>
    batch.flatMap((unit) => unit.instructions),
  )

  // The SOL sweep rides along in the last batch — or its own transaction if
  // there were no token accounts at all.
  const txCount = Math.max(batches.length, 1)
  const { sufficient, sweep } = computeSolSweep(solBalance, txCount)
  if (sweep > 0n) {
    const sweepInstruction = getTransferSolInstruction({ amount: sweep, destination, source })
    if (batches.length) {
      batches[batches.length - 1]?.push(sweepInstruction)
    } else {
      batches.push([sweepInstruction])
    }
  }

  return {
    batches,
    closedEmptyAccounts: sources.filter((a) => a.balance === 0n).length,
    estimatedNewAtaRent: BigInt(units.filter((u) => u.needsNewAta).length) * rent,
    insufficientSolForFees: !sufficient && solBalance > 0n,
    movedAssets: sources.filter((a) => a.balance > 0n),
    newAtaCount: units.filter((u) => u.needsNewAta).length,
    rentToDestination: sources.reduce((sum, a) => sum + a.lamports, 0n),
    solToSweep: sweep,
    txFeeTotal: TRANSACTION_FEE_LAMPORTS * BigInt(txCount),
  }
}
