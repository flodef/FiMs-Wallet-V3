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

export async function getTokenAccounts(
  client: SolanaClient,
  { address }: GetTokenAccountsOptions,
): Promise<GetTokenAccountsResult> {
  // Each program fetch is independent: a T22 parse/rpc failure must not hide
  // the legacy-token accounts (and vice-versa) — but a total failure still
  // surfaces as an error, not an empty wallet.
  const [tokenAccounts, token2022Accounts] = await Promise.allSettled([
    getTokenAccountsForProgramId(client, { address, programId: TOKEN_PROGRAM_ADDRESS }),
    getTokenAccountsForProgramId(client, { address, programId: TOKEN_2022_PROGRAM_ADDRESS }),
  ])
  if (tokenAccounts.status === 'rejected' && token2022Accounts.status === 'rejected') {
    throw tokenAccounts.reason
  }
  return [
    ...(tokenAccounts.status === 'fulfilled' ? tokenAccounts.value.value : []),
    ...(token2022Accounts.status === 'fulfilled' ? token2022Accounts.value.value : []),
  ]
}
