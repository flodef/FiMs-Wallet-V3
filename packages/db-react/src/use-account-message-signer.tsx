import type { Account } from '@workspace/db/account/account'
import { createKeyPairSignerFromJson } from '@workspace/keypair/create-key-pair-signer-from-json'
import { useAccountSecretKey } from './use-account-secret-key.tsx'
import { useConnectedWalletSigner } from './use-connected-wallet-signer.tsx'

// Message signer for any signable account: local keypair for derived/imported
// accounts, the injected wallet for 'Connected' ones. Watched accounts have
// no signer — callers must gate on `account.type` before using this.
export function useAccountMessageSigner() {
  const accountSecretKey = useAccountSecretKey()
  const connectedSigner = useConnectedWalletSigner()

  return async (account: Account) => {
    if (account.type === 'Connected') {
      return await connectedSigner(account)
    }
    const secretKey = await accountSecretKey({ account })
    return await createKeyPairSignerFromJson({ json: secretKey })
  }
}
