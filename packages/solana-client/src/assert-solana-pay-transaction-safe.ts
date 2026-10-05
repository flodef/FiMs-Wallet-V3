import type { Address } from '@solana/kit'
import { NATIVE_MINT } from './constants.ts'
import type { WireTransactionInspection } from './inspect-wire-transaction.ts'

// Programs a legitimate Solana Pay transaction-request transaction may invoke.
// Payments only ever need the SPL stack — anything else can hide a drainer
// behind a CPI that inherits the payer's signer privilege.
const SYSTEM_PROGRAM = '11111111111111111111111111111111'
const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'
const TOKEN_2022_PROGRAM = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'

const ALLOWED_PROGRAM_IDS = new Set<string>([
  SYSTEM_PROGRAM,
  'ComputeBudget111111111111111111111111111111',
  TOKEN_PROGRAM,
  TOKEN_2022_PROGRAM,
  'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL', // Associated Token
  'Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo',
  'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr',
])

// SPL Token / Token-2022 top-level discriminators that hand control of a
// token account to someone else — invisible to balance diffs.
const TOKEN_IX_APPROVE = 4
const TOKEN_IX_SET_AUTHORITY = 6
const TOKEN_IX_CLOSE_ACCOUNT = 9
const TOKEN_IX_APPROVE_CHECKED = 13

// System-program instruction types (u32 LE discriminator): only Create (0)
// and Transfer (2) are legitimate in a payment; Assign/Allocate/seeded
// variants rewrite the wallet's own account.
const ALLOWED_SYSTEM_IX_TYPES = new Set([0, 2])

export class SolanaPayInspectionError extends Error {
  constructor(reason: string) {
    super(`Solana Pay transaction rejected by local inspection: ${reason}`)
    this.name = 'SolanaPayInspectionError'
  }
}

// Checks a decoded+simulated merchant transaction-request before signing.
// Throws SolanaPayInspectionError on any anomaly — callers must not sign.
//
// Unlike the Jupiter check there is no spend budget: the payer reviews the
// simulated balance deltas on the confirmation screen and approves freely.
// Everything else still fails closed — unexpected signers, unknown programs,
// authority/delegate changes, foreign closes, wallet account reassignment.
export function assertSolanaPayTransactionSafe({
  account,
  inspection,
}: {
  account: Address
  inspection: WireTransactionInspection
}) {
  if (inspection.feePayer !== account) {
    throw new SolanaPayInspectionError(`fee payer ${inspection.feePayer ?? 'none'} is not the wallet`)
  }
  const preSigned = new Set(inspection.alreadySignedBy)
  for (const signer of inspection.requiredSigners) {
    if (signer !== account && !preSigned.has(signer)) {
      throw new SolanaPayInspectionError(`unexpected required signer ${signer}`)
    }
  }
  const unknownPrograms = inspection.programIds.filter((id) => !ALLOWED_PROGRAM_IDS.has(id))
  if (unknownPrograms.length) {
    throw new SolanaPayInspectionError(`unknown program(s): ${unknownPrograms.join(', ')}`)
  }
  if (inspection.simulation.status === 'failure') {
    throw new SolanaPayInspectionError(`simulation failed: ${JSON.stringify(inspection.simulation.error)}`)
  }
  if (!inspection.simulation.accountsReliable) {
    throw new SolanaPayInspectionError('simulated account states are incomplete')
  }

  for (const ix of inspection.instructions) {
    if (ix.hasUnresolvedAccounts || !ix.programId) {
      throw new SolanaPayInspectionError('instruction has unresolvable account references')
    }
    if (ix.programId === TOKEN_PROGRAM || ix.programId === TOKEN_2022_PROGRAM) {
      const instructionType = ix.data[0]
      if (instructionType === TOKEN_IX_APPROVE || instructionType === TOKEN_IX_APPROVE_CHECKED) {
        throw new SolanaPayInspectionError('approve instruction would delegate wallet funds')
      }
      if (instructionType === TOKEN_IX_SET_AUTHORITY) {
        throw new SolanaPayInspectionError('set-authority instruction would hand over an account')
      }
      if (instructionType === TOKEN_IX_CLOSE_ACCOUNT) {
        const destination = ix.accountAddresses[1]
        if (destination !== account) {
          throw new SolanaPayInspectionError(`close-account pays ${destination ?? 'unknown'} instead of the wallet`)
        }
      }
    }
    if (ix.programId === SYSTEM_PROGRAM) {
      const type = ix.data.length >= 4 ? new DataView(ix.data.buffer, ix.data.byteOffset).getUint32(0, true) : -1
      if (!ALLOWED_SYSTEM_IX_TYPES.has(type)) {
        throw new SolanaPayInspectionError(`unsupported system instruction type ${type}`)
      }
    }
  }

  if (inspection.simulation.walletOwnerAfter !== SYSTEM_PROGRAM) {
    throw new SolanaPayInspectionError(
      `wallet account owner changed to ${inspection.simulation.walletOwnerAfter ?? 'closed'}`,
    )
  }

  const walletSolChange =
    inspection.simulation.solBalanceChanges.find((change) => change.address === account)?.change ?? 0n

  for (const row of inspection.simulation.tokenAccounts) {
    if (row.ownerBefore !== account) {
      continue
    }
    if (row.destroyed) {
      if (row.mint !== NATIVE_MINT) {
        throw new SolanaPayInspectionError(`token account ${row.account} (${row.mint}) is closed`)
      }
      if (walletSolChange <= 0n) {
        throw new SolanaPayInspectionError(`wSOL account ${row.account} closed without returning lamports`)
      }
      continue
    }
    if (row.ownerAfter !== account) {
      throw new SolanaPayInspectionError(
        `token account ${row.account} ownership changed to ${row.ownerAfter ?? 'none'}`,
      )
    }
    if (row.delegateAfter) {
      throw new SolanaPayInspectionError(`delegate set on token account ${row.account}`)
    }
    if (row.closeAuthorityAfter && row.closeAuthorityAfter !== account) {
      throw new SolanaPayInspectionError(`close authority of ${row.account} changed to ${row.closeAuthorityAfter}`)
    }
  }
}
