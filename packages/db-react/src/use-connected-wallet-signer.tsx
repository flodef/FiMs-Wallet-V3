import { SolanaSignTransaction, type SolanaSignTransactionFeature } from '@solana/wallet-standard-features'
import { getWallets } from '@wallet-standard/app'
import { StandardConnect, type StandardConnectFeature } from '@wallet-standard/features'
import { AppError } from '@workspace/core/app-error'
import type { Account } from '@workspace/db/account/account'
import { createWalletStandardSigner, type WalletStandardSigner } from '@workspace/solana-client/wallet-standard-signer'

// The wallet we register ourselves to act as a wallet for dApps — it must
// not appear in the "connect external wallet" list.
const SELF_WALLET_NAME = 'FiMs'

export function useDetectedWallets() {
  return getWallets()
    .get()
    .filter((wallet) => wallet.name !== SELF_WALLET_NAME)
}

// Highest transaction version the account's signer can handle: a connected
// account is capped by what its wallet advertises, while local keypairs sign
// through kit v8 which builds and signs v1 natively. A watched account never
// signs — report the more widely supported v0.
export function getAccountTransactionVersion(account: Account): 0 | 1 {
  if (account.type === 'Watched') {
    return 0
  }
  if (account.type !== 'Connected') {
    return 1
  }
  const wallet = getWallets()
    .get()
    .find((w) => w.name === account.externalWallet)
  const feature = wallet?.features[SolanaSignTransaction] as
    | SolanaSignTransactionFeature[typeof SolanaSignTransaction]
    | undefined
  return feature?.supportedTransactionVersions?.includes(1) ? 1 : 0
}

// Signers are memoized by wallet+address: connecting again on every API call
// popped the wallet extension open/closed once per request (Solflare does it
// even for already-authorized connects), and racing connects can cancel a
// pending sign prompt.
const signerCache = new Map<string, Promise<WalletStandardSigner>>()

function resolveWalletSigner(account: Account): Promise<WalletStandardSigner> {
  const key = `${account.externalWallet}|${account.publicKey}`
  const cached = signerCache.get(key)
  if (cached) return cached
  const promise = (async () => {
    const wallet = getWallets()
      .get()
      .find((w) => w.name === account.externalWallet)
    if (!wallet) {
      throw new AppError(
        'externalWalletNotAvailable',
        `External wallet not available: ${account.externalWallet ?? account.publicKey}`,
        { name: account.externalWallet },
      )
    }
    const feature = wallet.features[StandardConnect] as StandardConnectFeature[typeof StandardConnect] | undefined
    if (!feature) {
      throw new AppError('walletNoConnectFeature', `${wallet.name} does not support standard:connect`, {
        name: wallet.name,
      })
    }
    const { accounts } = await feature.connect()
    const walletAccount = accounts.find((a) => a.address === account.publicKey)
    if (!walletAccount) {
      throw new AppError(
        'accountNotAuthorizedInWallet',
        `Account ${account.publicKey} not authorized in ${wallet.name}`,
        { name: wallet.name },
      )
    }
    return createWalletStandardSigner(wallet, walletAccount)
  })()
  signerCache.set(key, promise)
  // A rejected resolution must not be cached forever — the next call retries.
  promise.catch(() => signerCache.delete(key))
  return promise
}

// Resolves the wallet-standard signer for a 'Connected' account: finds the
// injected wallet by name, connects it once, then wraps the authorized
// account in a signer that delegates message/transaction signing to it.
export function useConnectedWalletSigner() {
  return (account: Account) => resolveWalletSigner(account)
}
