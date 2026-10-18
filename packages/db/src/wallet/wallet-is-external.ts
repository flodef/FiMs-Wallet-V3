// External wallets (Solflare, Phantom…) hold no secrets — the row is just a
// link. `externalWallet` is the explicit marker, stamped at connect and
// backfilled by migrations v4 (only for all-holding no secret wallets) + v6
// (un-stamps mislabeled ones). Do NOT keep an empty-derivationPath fallback:
// imported private-key wallets share that shape and hold real secrets.
export function walletIsExternal(wallet: { externalWallet?: string | undefined }): boolean {
  return !!wallet.externalWallet
}
