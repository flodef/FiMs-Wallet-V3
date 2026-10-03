import { AccountRole, type Address, type Instruction } from '@solana/kit'
import type { TransactionInstruction } from '@solana/web3.js'
import { PublicKey } from '@solana/web3.js'
import {
  getMultisigPda,
  getProgramConfigPda,
  getProposalPda,
  getSpendingLimitPda,
  getTransactionPda,
  getVaultPda,
  PROGRAM_ID,
  accounts as squadsAccounts,
  types as squadsTypes,
} from '@sqds/multisig'

// Squads v4 program — same deployment address on mainnet and devnet.
export const SQUADS_PROGRAM_ID = PROGRAM_ID.toBase58() as Address

// The Squads members given to every member at creation time: propose, vote
// and execute. Anything narrower would make the created multisig unusable
// from this wallet's UI.
export const SQUADS_MEMBER_PERMISSIONS = squadsTypes.Permissions.fromPermissions([
  squadsTypes.Permission.Initiate,
  squadsTypes.Permission.Vote,
  squadsTypes.Permission.Execute,
])

export function toPublicKey(value: Address | string): PublicKey {
  return new PublicKey(value.toString())
}

function toAccountRole({ isSigner, isWritable }: { isSigner: boolean; isWritable: boolean }): AccountRole {
  if (isWritable) {
    return isSigner ? AccountRole.WRITABLE_SIGNER : AccountRole.WRITABLE
  }
  return isSigner ? AccountRole.READONLY_SIGNER : AccountRole.READONLY
}

// Squads SDK instructions target @solana/web3.js v1; this wallet builds
// transactions with @solana/kit. The account metas map one-to-one.
export function toKitInstruction(instruction: TransactionInstruction): Instruction {
  return {
    accounts: instruction.keys.map((key) => ({
      address: key.pubkey.toBase58() as Address,
      role: toAccountRole(key),
    })),
    data: new Uint8Array(instruction.data),
    programAddress: instruction.programId.toBase58() as Address,
  }
}

export function toKitInstructions(instructions: TransactionInstruction[]): Instruction[] {
  return instructions.map(toKitInstruction)
}

export function squadsMultisigPda(createKey: Address): Address {
  return getMultisigPda({ createKey: toPublicKey(createKey) })[0].toBase58() as Address
}

export function squadsVaultPda(multisigPda: Address, index = 0): Address {
  return getVaultPda({ index, multisigPda: toPublicKey(multisigPda) })[0].toBase58() as Address
}

export function squadsTransactionPda(multisigPda: Address, index: bigint): Address {
  return getTransactionPda({ index, multisigPda: toPublicKey(multisigPda) })[0].toBase58() as Address
}

export function squadsProposalPda(multisigPda: Address, transactionIndex: bigint): Address {
  return getProposalPda({ multisigPda: toPublicKey(multisigPda), transactionIndex })[0].toBase58() as Address
}

export function squadsSpendingLimitPda(multisigPda: Address, createKey: Address): Address {
  return getSpendingLimitPda({
    createKey: toPublicKey(createKey),
    multisigPda: toPublicKey(multisigPda),
  })[0].toBase58() as Address
}

export function squadsProgramConfigPda(): Address {
  return getProgramConfigPda({})[0].toBase58() as Address
}

export interface SquadsMultisigInfo {
  configAuthority: Address
  members: { key: Address; permissions: number }[]
  threshold: number
  timeLock: number
  transactionIndex: bigint
}

export function decodeSquadsMultisig(data: Uint8Array): SquadsMultisigInfo {
  const [multisig] = squadsAccounts.Multisig.deserialize(Buffer.from(data))
  return {
    configAuthority: multisig.configAuthority.toBase58() as Address,
    members: multisig.members.map((member) => ({
      key: member.key.toBase58() as Address,
      permissions: member.permissions.mask,
    })),
    threshold: multisig.threshold,
    timeLock: multisig.timeLock,
    transactionIndex: BigInt(multisig.transactionIndex.toString()),
  }
}

export type SquadsProposalStatus = 'active' | 'approved' | 'cancelled' | 'draft' | 'executed' | 'rejected'

export interface SquadsProposalInfo {
  approved: Address[]
  cancelled: Address[]
  index: bigint
  multisig: Address
  pda: Address
  rejected: Address[]
  status: SquadsProposalStatus
}

const PROPOSAL_STATUS_MAP: Record<string, SquadsProposalStatus> = {
  Active: 'active',
  Approved: 'approved',
  Cancelled: 'cancelled',
  Draft: 'draft',
  Executed: 'executed',
  Executing: 'approved',
  Rejected: 'rejected',
}

export function decodeSquadsProposal(data: Uint8Array, pda: Address): SquadsProposalInfo {
  const [proposal] = squadsAccounts.Proposal.deserialize(Buffer.from(data))
  const kind = (proposal.status as { __kind: string }).__kind
  const mapped = PROPOSAL_STATUS_MAP[kind] ?? 'active'
  return {
    approved: proposal.approved.map((key) => key.toBase58() as Address),
    cancelled: proposal.cancelled.map((key) => key.toBase58() as Address),
    index: BigInt(proposal.transactionIndex.toString()),
    multisig: proposal.multisig.toBase58() as Address,
    pda,
    rejected: proposal.rejected.map((key) => key.toBase58() as Address),
    status: mapped,
  }
}

export interface SquadsSpendingLimitInfo {
  amount: bigint
  destinations: Address[]
  members: Address[]
  mint: Address
  period: 'day' | 'month' | 'onetime' | 'week'
  remainingAmount: bigint
  vaultIndex: number
}

const PERIOD_MAP: Record<number, SquadsSpendingLimitInfo['period']> = {
  0: 'onetime',
  1: 'day',
  2: 'week',
  3: 'month',
}

export const SQUADS_PERIOD_TO_ENUM: Record<SquadsSpendingLimitInfo['period'], squadsTypes.Period> = {
  day: squadsTypes.Period.Day,
  month: squadsTypes.Period.Month,
  onetime: squadsTypes.Period.OneTime,
  week: squadsTypes.Period.Week,
}

export function decodeSquadsSpendingLimit(data: Uint8Array): SquadsSpendingLimitInfo {
  const [limit] = squadsAccounts.SpendingLimit.deserialize(Buffer.from(data))
  return {
    amount: BigInt(limit.amount.toString()),
    destinations: limit.destinations.map((key) => key.toBase58() as Address),
    members: limit.members.map((key) => key.toBase58() as Address),
    mint: limit.mint.toBase58() as Address,
    period: PERIOD_MAP[limit.period as number] ?? 'onetime',
    remainingAmount: BigInt(limit.remainingAmount.toString()),
    vaultIndex: limit.vaultIndex,
  }
}

export function decodeSquadsProgramConfig(data: Uint8Array): { treasury: Address } {
  const [config] = squadsAccounts.ProgramConfig.deserialize(Buffer.from(data))
  return { treasury: config.treasury.toBase58() as Address }
}

// Discriminators to tell vault transactions from config transactions at the
// shared transaction PDA when listing proposals.
export const SQUADS_VAULT_TX_DISCRIMINATOR = squadsAccounts.vaultTransactionDiscriminator
export const SQUADS_CONFIG_TX_DISCRIMINATOR = squadsAccounts.configTransactionDiscriminator
