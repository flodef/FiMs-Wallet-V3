import type { Address, Instruction, TransactionSigner } from '@solana/kit'
import { Connection, SystemProgram, TransactionMessage } from '@solana/web3.js'
import { instructions as squadsInstructions } from '@sqds/multisig'
import BN from 'bn.js'
import {
  SQUADS_MEMBER_PERMISSIONS,
  SQUADS_PERIOD_TO_ENUM,
  type SquadsSpendingLimitInfo,
  toKitInstruction,
  toKitInstructions,
  toPublicKey,
} from './squads.ts'

export interface CreateMultisigInput {
  createKey: TransactionSigner
  creator: Address
  members: Address[]
  multisigPda: Address
  threshold: number
  treasury: Address
}

// multisigCreateV2 requires the createKey account itself to sign — it anchors
// the multisig PDA. The kit transaction pipeline collects extra signers from
// instruction account metas, so the signer is embedded on the createKey meta.
export function buildCreateMultisigInstructions(input: CreateMultisigInput): Instruction[] {
  const instructions = toKitInstructions([
    squadsInstructions.multisigCreateV2({
      configAuthority: null,
      createKey: toPublicKey(input.createKey.address),
      creator: toPublicKey(input.creator),
      members: input.members.map((key) => ({ key: toPublicKey(key), permissions: SQUADS_MEMBER_PERMISSIONS })),
      multisigPda: toPublicKey(input.multisigPda),
      rentCollector: null,
      threshold: input.threshold,
      timeLock: 0,
      treasury: toPublicKey(input.treasury),
    }),
  ])
  return instructions.map((instruction) => ({
    ...instruction,
    ...(instruction.accounts
      ? {
          accounts: instruction.accounts.map((meta) =>
            meta.address === input.createKey.address ? { ...meta, signer: input.createKey } : meta,
          ),
        }
      : {}),
  }))
}

export interface VaultTransferProposalInput {
  creator: Address
  destination: Address
  lamports: bigint
  latestBlockhash: string
  multisigPda: Address
  transactionIndex: bigint
  vaultPda: Address
}

// Proposing a vault spend takes two instructions in one transaction: create
// the vault transaction (the wrapped message) then open its proposal.
export function buildVaultTransferProposalInstructions(input: VaultTransferProposalInput): Instruction[] {
  // The SDK wraps the message itself — it expects the uncompiled message.
  const message = new TransactionMessage({
    instructions: [
      SystemProgram.transfer({
        fromPubkey: toPublicKey(input.vaultPda),
        lamports: Number(input.lamports),
        toPubkey: toPublicKey(input.destination),
      }),
    ],
    payerKey: toPublicKey(input.vaultPda),
    recentBlockhash: input.latestBlockhash,
  })

  return toKitInstructions([
    squadsInstructions.vaultTransactionCreate({
      creator: toPublicKey(input.creator),
      ephemeralSigners: 0,
      multisigPda: toPublicKey(input.multisigPda),
      transactionIndex: input.transactionIndex,
      transactionMessage: message,
      vaultIndex: 0,
    }),
    squadsInstructions.proposalCreate({
      creator: toPublicKey(input.creator),
      isDraft: false,
      multisigPda: toPublicKey(input.multisigPda),
      transactionIndex: input.transactionIndex,
    }),
  ])
}

export interface SpendingLimitProposalInput {
  amount: bigint
  creator: Address
  destinations: Address[]
  members: Address[]
  mint: Address
  multisigPda: Address
  period: SquadsSpendingLimitInfo['period']
  spendingLimitCreateKey: Address
  transactionIndex: bigint
}

// The on-chain version of the wallet's EUR send cap: a spending limit stored
// by the program and enforced at execution, not by client-side UI code.
export function buildSpendingLimitProposalInstructions(input: SpendingLimitProposalInput): Instruction[] {
  return toKitInstructions([
    squadsInstructions.configTransactionCreate({
      actions: [
        {
          __kind: 'AddSpendingLimit',
          amount: new BN(input.amount.toString()),
          createKey: toPublicKey(input.spendingLimitCreateKey),
          destinations: input.destinations.map(toPublicKey),
          members: input.members.map(toPublicKey),
          mint: toPublicKey(input.mint),
          period: SQUADS_PERIOD_TO_ENUM[input.period],
          vaultIndex: 0,
        },
      ],
      creator: toPublicKey(input.creator),
      multisigPda: toPublicKey(input.multisigPda),
      transactionIndex: input.transactionIndex,
    }),
    squadsInstructions.proposalCreate({
      creator: toPublicKey(input.creator),
      isDraft: false,
      multisigPda: toPublicKey(input.multisigPda),
      transactionIndex: input.transactionIndex,
    }),
  ])
}

export interface ProposalVoteInput {
  kind: 'approve' | 'cancel' | 'reject'
  member: Address
  multisigPda: Address
  transactionIndex: bigint
}

export function buildProposalVoteInstructions(input: ProposalVoteInput): Instruction[] {
  const base = {
    member: toPublicKey(input.member),
    multisigPda: toPublicKey(input.multisigPda),
    transactionIndex: input.transactionIndex,
  }
  if (input.kind === 'approve') {
    return toKitInstructions([squadsInstructions.proposalApprove(base)])
  }
  if (input.kind === 'reject') {
    return toKitInstructions([squadsInstructions.proposalReject(base)])
  }
  return toKitInstructions([squadsInstructions.proposalCancel(base)])
}

export interface ExecuteTransactionInput {
  member: Address
  multisigPda: Address
  rpcUrl: string
  spendingLimitPdas?: Address[]
  transactionIndex: bigint
}

// vaultTransactionExecute resolves address lookup tables through a web3.js
// Connection — the only place the legacy client is still needed.
export async function buildExecuteInstructions(input: ExecuteTransactionInput): Promise<Instruction[]> {
  const { instruction } = await squadsInstructions.vaultTransactionExecute({
    connection: new Connection(input.rpcUrl),
    member: toPublicKey(input.member),
    multisigPda: toPublicKey(input.multisigPda),
    transactionIndex: input.transactionIndex,
  })
  return [toKitInstruction(instruction)]
}

// Executing a config transaction that adds a spending limit creates a new
// on-chain account — the member doubles as rent payer so the program has a
// funded signer to allocate it, and the new PDAs ride as remaining accounts.
export function buildConfigExecuteInstructions(input: ExecuteTransactionInput): Instruction[] {
  return toKitInstructions([
    squadsInstructions.configTransactionExecute({
      member: toPublicKey(input.member),
      multisigPda: toPublicKey(input.multisigPda),
      rentPayer: toPublicKey(input.member),
      ...(input.spendingLimitPdas ? { spendingLimits: input.spendingLimitPdas.map(toPublicKey) } : {}),
      transactionIndex: input.transactionIndex,
    }),
  ])
}

export interface SpendingLimitUseInput {
  amount: bigint
  destination: Address
  member: Address
  multisigPda: Address
  spendingLimitPda: Address
  vaultIndex: number
}

// spendingLimitUse lets a whitelisted member spend straight from the vault —
// no proposal, no threshold — capped by the on-chain spending limit. SOL only:
// mint is omitted so the program takes the native transfer path.
export function buildSpendingLimitUseInstructions(input: SpendingLimitUseInput): Instruction[] {
  return [
    toKitInstruction(
      squadsInstructions.spendingLimitUse({
        amount: Number(input.amount),
        decimals: 9,
        destination: toPublicKey(input.destination),
        member: toPublicKey(input.member),
        multisigPda: toPublicKey(input.multisigPda),
        spendingLimit: toPublicKey(input.spendingLimitPda),
        vaultIndex: input.vaultIndex,
      }),
    ),
  ]
}
