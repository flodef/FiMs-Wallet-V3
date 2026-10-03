import { type Address, getBase58Decoder, getBase64Encoder, type Instruction, type Signature } from '@solana/kit'
import { accounts as squadsAccounts } from '@sqds/multisig'
import type { Account } from '@workspace/db/account/account'
import type { Network } from '@workspace/db/network/network'
import { useAccountSecretKey } from '@workspace/db-react/use-account-secret-key'
import { createKeyPairSignerFromJson } from '@workspace/keypair/create-key-pair-signer-from-json'
import { sendSimulatedPreparedTransaction } from '@workspace/solana-client/send-prepared-transaction'
import type { SolanaClient } from '@workspace/solana-client/solana-client'
import { useSolanaClient } from '@workspace/solana-client-react/use-solana-client'
import { useCallback } from 'react'
import {
  decodeSquadsConfigTransactionSpendingLimitPdas,
  decodeSquadsMultisig,
  decodeSquadsProgramConfig,
  decodeSquadsProposal,
  decodeSquadsSpendingLimit,
  SQUADS_CONFIG_TX_DISCRIMINATOR,
  SQUADS_PROGRAM_ID,
  SQUADS_VAULT_TX_DISCRIMINATOR,
  type SquadsMultisigInfo,
  type SquadsProgramConfig,
  type SquadsProposalInfo,
  type SquadsSpendingLimitInfo,
  squadsProgramConfigPda,
  squadsTransactionPda,
} from './squads.ts'

const base64Encoder = getBase64Encoder()
const base58Decoder = getBase58Decoder()

function decodeAccountData(raw: unknown): Uint8Array | null {
  const [encoded] = raw as [string, string]
  return encoded ? Uint8Array.from(base64Encoder.encode(encoded)) : null
}

async function fetchAccountData(client: SolanaClient, address: Address): Promise<Uint8Array | null> {
  const { value } = await client.rpc.getAccountInfo(address, { encoding: 'base64' }).send()
  return value ? decodeAccountData(value.data) : null
}

export async function fetchSquadsProgramConfig(client: SolanaClient): Promise<SquadsProgramConfig> {
  const data = await fetchAccountData(client, squadsProgramConfigPda())
  if (!data) {
    throw new Error('Squads program config account not found on this network')
  }
  return decodeSquadsProgramConfig(data)
}

export async function fetchSquadsMultisig(
  client: SolanaClient,
  multisigPda: Address,
): Promise<SquadsMultisigInfo | null> {
  const data = await fetchAccountData(client, multisigPda)
  return data ? decodeSquadsMultisig(data) : null
}

export interface SquadsProposalRow extends SquadsProposalInfo {
  kind: 'config' | 'unknown' | 'vault'
  spendingLimitPdas: Address[]
}

function matchesDiscriminator(data: Uint8Array | null, discriminator: number[]): boolean {
  return !!data && data.length >= 8 && discriminator.every((byte, index) => data[index] === byte)
}

function discriminatorB58(discriminator: number[]): string {
  return base58Decoder.decode(Uint8Array.from(discriminator))
}

// Proposal and SpendingLimit accounts hold `multisig` at offset 8 (right after
// the 8-byte discriminator); the discriminator memcmp keeps other account
// types sharing that offset layout out of the result set.
async function fetchSquadsAccounts<T>(
  client: SolanaClient,
  multisigPda: Address,
  discriminator: number[],
  decode: (data: Uint8Array, pda: Address) => T,
): Promise<T[]> {
  const accounts = await client.rpc
    .getProgramAccounts(SQUADS_PROGRAM_ID, {
      encoding: 'base64',
      filters: [
        { memcmp: { bytes: multisigPda as never, encoding: 'base58', offset: 8n } },
        { memcmp: { bytes: discriminatorB58(discriminator) as never, encoding: 'base58', offset: 0n } },
      ],
    })
    .send()
  return accounts.flatMap((account) => {
    const data = decodeAccountData(account.account.data)
    return data ? [decode(data, account.pubkey)] : []
  })
}

export async function fetchSquadsProposals(client: SolanaClient, multisigPda: Address): Promise<SquadsProposalRow[]> {
  const proposals = await fetchSquadsAccounts(
    client,
    multisigPda,
    squadsAccounts.proposalDiscriminator,
    decodeSquadsProposal,
  )
  // The transaction account at the same index tells vault vs config spend.
  const rows = await Promise.all(
    proposals.map(async (proposal): Promise<SquadsProposalRow> => {
      const txData = await fetchAccountData(client, squadsTransactionPda(multisigPda, proposal.index))
      const kind = matchesDiscriminator(txData, SQUADS_VAULT_TX_DISCRIMINATOR)
        ? ('vault' as const)
        : matchesDiscriminator(txData, SQUADS_CONFIG_TX_DISCRIMINATOR)
          ? ('config' as const)
          : ('unknown' as const)
      const spendingLimitPdas =
        kind === 'config' && txData ? decodeSquadsConfigTransactionSpendingLimitPdas(txData, multisigPda) : []
      return { ...proposal, kind, spendingLimitPdas }
    }),
  )
  return rows.sort((a, b) => (a.index > b.index ? -1 : 1))
}

export async function fetchSquadsSpendingLimits(
  client: SolanaClient,
  multisigPda: Address,
): Promise<{ info: SquadsSpendingLimitInfo; pda: Address }[]> {
  const limits = await fetchSquadsAccounts(
    client,
    multisigPda,
    squadsAccounts.spendingLimitDiscriminator,
    (data, pda) => ({
      info: decodeSquadsSpendingLimit(data),
      pda,
    }),
  )
  return limits
}

// Signs and sends a transaction built from kit instructions through the same
// simulate-then-send pipeline as regular transfers.
export function useSquadsSignAndSend({ account, network }: { account: Account; network: Network }) {
  const client = useSolanaClient({ network })
  const accountSecretKey = useAccountSecretKey()

  const signAndSend = useCallback(
    async (instructions: Instruction[]): Promise<Signature> => {
      const json = await accountSecretKey({ account })
      const transactionSigner = await createKeyPairSignerFromJson({ json })
      const result = await sendSimulatedPreparedTransaction(client, { instructions, transactionSigner })
      if (!result.signature) {
        throw new Error(`Squads transaction simulation failed: ${JSON.stringify(result.simulation)}`)
      }
      return result.signature
    },
    [account, accountSecretKey, client],
  )

  return { client, signAndSend }
}
