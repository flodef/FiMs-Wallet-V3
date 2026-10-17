// External wallets (Solflare, Phantom…) hold no secrets — the row is just a
// link. `externalWallet` is the explicit marker; rows written before it was
// persisted are still external: only they have an empty derivationPath.
export function walletIsExternal(wallet: { derivationPath: string; externalWallet?: string | undefined }): boolean {
  return !!wallet.externalWallet || wallet.derivationPath.length === 0
}
