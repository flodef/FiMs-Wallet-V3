import type { Account } from '@workspace/db/account/account'
import type { Wallet } from '@workspace/db/wallet/wallet'
import {
  WALLET_TRANSFER_KIND,
  WALLET_TRANSFER_VERSION,
  walletTransferEncode,
} from '@workspace/db/wallet/wallet-transfer'
import { useAccountReadSecretKey } from '@workspace/db-react/use-account-read-secret-key'
import { useWalletReadMnemonic } from '@workspace/db-react/use-wallet-read-mnemonic'

// Device-to-device transfer (Jupiter Sync style): bundles the wallet's
// mnemonic plus every local account key into a QR-decodable payload. The
// caller is responsible for unlocking the vault first — secrets never
// leave the device except through the QR/copy channel itself.
export function useWalletTransferExport() {
  const readMnemonic = useWalletReadMnemonic()
  const readSecretKey = useAccountReadSecretKey()

  return async (wallet: Wallet, accounts: Account[]): Promise<string> => {
    // Private-key wallets have no recovery phrase — the mnemonic slot stays
    // empty and the accounts carry their imported keys.
    const mnemonic = wallet.derivationPath.length ? await readMnemonic.mutateAsync({ id: wallet.id }) : ''
    const exported = await Promise.all(
      accounts
        .filter((account) => account.type !== 'Watched' && account.type !== 'Connected')
        .map(async (account) => ({
          derivationIndex: account.derivationIndex ?? 0,
          name: account.name,
          publicKey: account.publicKey,
          secretKey: await readSecretKey.mutateAsync({ id: account.id }),
          type: account.type as 'Derived' | 'Imported',
        })),
    )
    return walletTransferEncode({
      accounts: exported,
      derivationPath: wallet.derivationPath,
      kind: WALLET_TRANSFER_KIND,
      mnemonic,
      name: wallet.name,
      v: WALLET_TRANSFER_VERSION,
    })
  }
}
