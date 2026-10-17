import type { Address } from '@solana/kit'
import { TOKEN_PROGRAM_ADDRESS } from '@solana-program/token'
import { TOKEN_2022_PROGRAM_ADDRESS } from '@solana-program/token-2022'
import {
  type GetTokenAccountsForProgramIdResult,
  getTokenAccountsForProgramId,
} from './get-token-accounts-for-program-id.ts'
import type { SolanaClient } from './solana-client.ts'

export interface GetTokenAccountsOptions {
  address: Address
}

export type GetTokenAccountsResult = GetTokenAccountsForProgramIdResult['value']

export interface GetTokenAccountsDetailedResult {
  accounts: GetTokenAccountsResult
  // Token programs whose fetch failed — the list above is then incomplete
  // and the UI must say so instead of showing a silently partial wallet.
  failedPrograms: Address[]
}

// Each program fetch is independent: a Token-2022 failure must not hide the
// legacy-token accounts (and vice-versa) — but a total failure still rejects,
// so an empty wallet is never fabricated from two errors.
export async function getTokenAccountsDetailed(
  client: SolanaClient,
  { address }: GetTokenAccountsOptions,
): Promise<GetTokenAccountsDetailedResult> {
  const programs = [TOKEN_PROGRAM_ADDRESS, TOKEN_2022_PROGRAM_ADDRESS]
  const settled = await Promise.allSettled(
    programs.map((programId) => getTokenAccountsForProgramId(client, { address, programId })),
  )
  const firstFailure = settled.find((result) => result.status === 'rejected')
  if (firstFailure && settled.every((result) => result.status === 'rejected')) {
    throw firstFailure.reason
  }
  return {
    accounts: settled.flatMap((result) => (result.status === 'fulfilled' ? result.value.value : [])),
    failedPrograms: programs.filter((_, index) => settled[index]?.status === 'rejected'),
  }
}

export async function getTokenAccounts(
  client: SolanaClient,
  options: GetTokenAccountsOptions,
): Promise<GetTokenAccountsResult> {
  return (await getTokenAccountsDetailed(client, options)).accounts
}
