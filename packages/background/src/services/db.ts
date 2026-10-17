import { address, createKeyPairFromBytes, getAddressEncoder } from '@solana/kit'
import { SOLANA_CHAINS } from '@solana/wallet-standard-chains'
import {
  SolanaSignAndSendTransaction,
  SolanaSignIn,
  SolanaSignMessage,
  SolanaSignTransaction,
} from '@solana/wallet-standard-features'
import type { StandardConnectOutput } from '@wallet-standard/core'
import type { ProxyService, ProxyServiceKey } from '@webext-core/proxy-service'
import { createProxyService, registerService } from '@webext-core/proxy-service'
import type { AppContext } from '@workspace/context/app-context'
import type { Account } from '@workspace/db/account/account'
import { accountCreate } from '@workspace/db/account/account-create'
import { accountFindMany } from '@workspace/db/account/account-find-many'
import { accountReadSecretKey } from '@workspace/db/account/account-read-secret-key'
import type { Network } from '@workspace/db/network/network'
import { networkFindMany } from '@workspace/db/network/network-find-many'
import { hasAdminAccount, resolveActiveAccount, resolveAllowedNetwork } from '@workspace/db/session/resolve-session'
import { settingFindUnique } from '@workspace/db/setting/setting-find-unique'
import { walletCreate } from '@workspace/db/wallet/wallet-create'
import type { WalletCreateInput } from '@workspace/db/wallet/wallet-create-input'
import { walletFindMany } from '@workspace/db/wallet/wallet-find-many'
import { envAdminAddresses } from '@workspace/env/env'
import { deriveFromMnemonicAtIndex } from '@workspace/keypair/derive-from-mnemonic-at-index'
import { ellipsify } from '@workspace/ui/lib/ellipsify'

// Session rules (active account, allowed network) come from the shared pure
// resolvers in @workspace/db/session — the same ones the web root loader uses.
function createDbService(ctx: AppContext) {
  return {
    account: {
      active: async (): Promise<Account> => {
        // Same resolution as the web root loader: a dangling or unset
        // activeAccountId falls back to the first visible account.
        const [accounts, wallets, activeAccountId] = await Promise.all([
          accountFindMany(ctx),
          walletFindMany(ctx),
          settingFindUnique(ctx, 'activeAccountId'),
        ])
        const { account } = resolveActiveAccount({ accounts, activeAccountId: activeAccountId?.value, wallets })
        if (!account) {
          throw new Error('No active account set')
        }
        return account
      },
      byPublicKey: async (publicKey: string): Promise<Account | undefined> => {
        const accounts = await accountFindMany(ctx, { publicKey: address(publicKey) })
        return accounts[0]
      },
      keyPair: async (): Promise<CryptoKeyPair> => {
        const secretKey = await getDbService().account.secretKey()

        return await createKeyPairFromBytes(new Uint8Array(JSON.parse(secretKey)))
      },
      keyPairForAccount: async (accountId: string): Promise<CryptoKeyPair> => {
        const secretKey = await accountReadSecretKey(ctx, accountId)
        if (!secretKey) {
          throw new Error('Account secretKey not found')
        }
        return await createKeyPairFromBytes(new Uint8Array(JSON.parse(secretKey)))
      },
      secretKey: async (): Promise<string> => {
        const { id: accountId } = await getDbService().account.active()
        const secretKey = await accountReadSecretKey(ctx, accountId)
        if (!secretKey) {
          throw new Error('Active account secretKey not found')
        }

        return secretKey
      },
      walletAccounts: async (): Promise<StandardConnectOutput> => {
        const account = await getDbService().account.active()

        return {
          accounts: [
            {
              address: account.publicKey,
              chains: SOLANA_CHAINS,
              features: [SolanaSignAndSendTransaction, SolanaSignIn, SolanaSignMessage, SolanaSignTransaction],
              // icon: undefined,
              // label: undefined,
              publicKey: getAddressEncoder().encode(address(account.publicKey)),
            },
          ],
        }
      },
    },
    network: {
      active: async (): Promise<Network> => {
        // dApp requests go through here, not the web root loader: apply the
        // same mainnet-only policy for non-admin devices (no demo in the
        // extension).
        const [accounts, networks, activeNetworkId] = await Promise.all([
          accountFindMany(ctx),
          networkFindMany(ctx),
          settingFindUnique(ctx, 'activeNetworkId'),
        ])
        const { network } = resolveAllowedNetwork({
          activeNetworkId: activeNetworkId?.value,
          demo: false,
          isAdmin: hasAdminAccount(accounts, envAdminAddresses()),
          networks,
        })
        if (!network) {
          throw new Error('Active network not found')
        }
        return network
      },
    },
    wallet: {
      createWithAccount: async (input: WalletCreateInput) => {
        // First, we see if we can derive the first account from this mnemonic
        const derivedAccount = await deriveFromMnemonicAtIndex({ mnemonic: input.mnemonic })
        // If so, we create the wallet
        const walletId = await walletCreate(ctx, input)
        // After creating the wallet we can create the account
        await accountCreate(ctx, {
          ...derivedAccount,
          name: ellipsify(derivedAccount.publicKey),
          type: 'Derived',
          walletId,
        })
        return walletId
      },
    },
  }
}

type DbService = ReturnType<typeof createDbService>

const dbServiceKey = 'DbService' as ProxyServiceKey<DbService>
let dbService: DbService | undefined

export function getDbService(): ProxyService<DbService> {
  return (dbService ?? createProxyService(dbServiceKey)) as ProxyService<DbService>
}

export function registerDbService(ctx: AppContext): DbService {
  dbService = createDbService(ctx)
  registerService(dbServiceKey, dbService)
  return dbService
}
