// Pure matching for external-wallet connect: find the local wallet row a
// wallet-standard extension corresponds to. The stamped marker wins; the
// legacy fallback (empty derivationPath + truncated name) additionally
// requires EVERY account on the row to be secret-free — an imported-key
// wallet sharing the name must not be re-stamped external.
import type { Account } from '@workspace/db/account/account'
import type { Wallet } from '@workspace/db/wallet/wallet'

export function findExternalWalletRow(
  wallets: Wallet[],
  accounts: Account[],
  externalName: string,
): Wallet | undefined {
  const allSecretFree = (walletId: string) =>
    accounts.every((a) => a.walletId !== walletId || a.type === 'Connected' || a.type === 'Watched')
  return (
    wallets.find((item) => item.externalWallet === externalName) ??
    wallets.find(
      (item) => item.derivationPath === '' && item.name === externalName.slice(0, 20) && allSecretFree(item.id),
    )
  )
}
