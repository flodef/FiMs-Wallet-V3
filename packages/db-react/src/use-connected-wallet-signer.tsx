import { getWallets } from '@wallet-standard/app'
import { StandardConnect, type StandardConnectFeature } from '@wallet-standard/features'
import type { Account } from '@workspace/db/account/account'
import { createWalletStandardSigner } from '@workspace/solana-client/wallet-standard-signer'

// The wallet we register ourselves to act as a wallet for dApps — it must
// not appear in the "connect external wallet" list.
const SELF_WALLET_NAME = 'FiMs'

export function useDetectedWallets() {
  return getWallets()
    .get()
    .filter((wallet) => wallet.name !== SELF_WALLET_NAME)
}

// Resolves the wallet-standard signer for a 'Connected' account: finds the
// injected wallet by name, (re)connects it, then wraps the authorized
// account in a signer that delegates message/transaction signing to it.
export function useConnectedWalletSigner() {
  return async (account: Account) => {
    const wallet = getWallets()
      .get()
      .find((w) => w.name === account.externalWallet)
    if (!wallet) {
      throw new Error(`External wallet not available: ${account.externalWallet ?? account.publicKey}`)
    }
    const feature = wallet.features[StandardConnect] as StandardConnectFeature[typeof StandardConnect] | undefined
    if (!feature) {
      throw new Error(`${wallet.name} does not support standard:connect`)
    }
    const { accounts } = await feature.connect()
    const walletAccount = accounts.find((a) => a.address === account.publicKey)
    if (!walletAccount) {
      throw new Error(`Account ${account.publicKey} not authorized in ${wallet.name}`)
    }
    return createWalletStandardSigner(wallet, walletAccount)
  }
}
