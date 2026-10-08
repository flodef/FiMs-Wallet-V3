import type { Address } from '@solana/kit'
import { fetchAccount } from './fetch-account.ts'
import { type AccountType, getAccountType } from './get-account-type.ts'
import type { SolanaClient } from './solana-client.ts'

// Sending funds to a token-program-owned address (a mint or a token account)
// means the tokens land in an ATA owned by an address nobody controls — the
// funds are burned forever. Same for program accounts under the loaders. The
// UI and the tx builder must both refuse these destinations.
const UNSAFE_SEND_DESTINATION_TYPES = new Set<AccountType>([
  'system-program',
  'token-account',
  'token-mint',
  'token-unknown',
])

/** Returns the unsafe account type when `address` cannot be a wallet, else null.
 *  Unknown program-owned PDAs (e.g. Squads vaults) stay allowed — they are
 *  legitimate destinations that can own ATAs. */
export async function getUnsafeSendDestinationType(
  client: SolanaClient,
  address: Address,
): Promise<AccountType | null> {
  const account = await fetchAccount(client, { address, throwOnError: false })
  const accountType = getAccountType({ account })
  return UNSAFE_SEND_DESTINATION_TYPES.has(accountType) ? accountType : null
}
