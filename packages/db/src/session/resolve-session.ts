import type { Account } from '../account/account.ts'
import type { Network } from '../network/network.ts'
import type { Setting } from '../setting/setting.ts'
import type { Wallet } from '../wallet/wallet.ts'

// Pure session resolution shared by the web root loader and the extension
// background, so both apply the exact same rules to the same Dexie rows.

// Accounts in the order the user sees them: wallet order, then account order.
export function orderedAccounts(accounts: Account[], wallets: Pick<Wallet, 'id' | 'order'>[]): Account[] {
  const walletOrder = new Map(wallets.map((wallet) => [wallet.id, wallet.order]))
  return [...accounts].sort(
    (a, b) =>
      (walletOrder.get(a.walletId) ?? Number.MAX_SAFE_INTEGER) -
        (walletOrder.get(b.walletId) ?? Number.MAX_SAFE_INTEGER) || a.order - b.order,
  )
}

// The active account, or the first visible one when activeAccountId is unset
// or dangling (account deleted while active). `repaired` tells the caller to
// persist the new id.
export function resolveActiveAccount({
  accounts,
  activeAccountId,
  wallets,
}: {
  accounts: Account[]
  activeAccountId: null | string | undefined
  wallets: Pick<Wallet, 'id' | 'order'>[]
}): { account: Account | null; repaired: boolean } {
  const current = activeAccountId ? accounts.find((account) => account.id === activeAccountId) : undefined
  if (current) {
    return { account: current, repaired: false }
  }
  const fallback = orderedAccounts(accounts, wallets)[0] ?? null
  return { account: fallback, repaired: fallback !== null }
}

// Admin = the device holds a SIGNING account whose key is an admin address.
// A watched account proves nothing (anyone can watch any public key), so it
// never unlocks admin UI. Server-side checks stay the real authority.
export function hasAdminAccount(accounts: Pick<Account, 'publicKey' | 'type'>[], adminAddresses: string[]): boolean {
  if (!adminAddresses.length) {
    return false
  }
  return accounts.some((account) => account.type !== 'Watched' && adminAddresses.includes(account.publicKey))
}

// Non-mainnet public networks are an admin/debug feature. Localnet stays
// allowed (scripted e2e drives it, no user lands there by accident); the
// guided demo may run on devnet. Returns the network to switch to, or null
// when the current one is fine.
export function resolveAllowedNetwork({
  activeNetworkId,
  demo,
  isAdmin,
  networks,
}: {
  activeNetworkId: null | string | undefined
  demo: boolean
  isAdmin: boolean
  networks: Network[]
}): { network: Network | null; repaired: boolean } {
  const current = networks.find((network) => network.id === activeNetworkId)
  const restricted = current?.type === 'solana:devnet' || current?.type === 'solana:testnet'
  if (current && (!restricted || isAdmin || demo)) {
    return { network: current, repaired: false }
  }
  const mainnet = networks.find((network) => network.type === 'solana:mainnet') ?? null
  // Degenerate config (no mainnet row at all): keep the current network
  // rather than null — a non-admin then stays on devnet, but with zero
  // usable mainnet there is nothing better to switch to.
  return { network: mainnet ?? current ?? null, repaired: mainnet !== null && mainnet.id !== current?.id }
}

export function settingValue(settings: Pick<Setting, 'key' | 'value'>[], key: Setting['key']): null | string {
  return settings.find((setting) => setting.key === key)?.value ?? null
}
