import { encryptWithVaultKey, isEncryptedValue } from '@workspace/vault/encrypted-value'
import {
  createUnsecuredWalletProtection,
  isWalletProtection,
  unlockUnsecuredWalletProtection,
} from '@workspace/vault/wallet-protection'
import { Dexie, type Table, type Transaction } from 'dexie'
import type { AccountInternal } from './account/account-internal.ts'
import { accountSanitizer } from './account/account-sanitizer.ts'
import type { BookmarkAccount } from './bookmark-account/bookmark-account.ts'
import type { BookmarkTransaction } from './bookmark-transaction/bookmark-transaction.ts'
import type { ChainSyncState } from './chain/chain-sync-state.ts'
import type { ChainTransactionRecord } from './chain/chain-transaction.ts'
import { createDbVault } from './create-db-vault.ts'
import type { Network } from './network/network.ts'
import { populate } from './populate.ts'
import type { Setting } from './setting/setting.ts'
import type { WalletInternal } from './wallet/wallet-internal.ts'
import { walletSanitizer } from './wallet/wallet-sanitizer.ts'

export interface DatabaseConfig {
  name: string
}

export class Database extends Dexie {
  accounts!: Table<AccountInternal>
  bookmarkAccounts!: Table<BookmarkAccount>
  bookmarkTransactions!: Table<BookmarkTransaction>
  chainSyncState!: Table<ChainSyncState>
  chainTransactions!: Table<ChainTransactionRecord>
  networks!: Table<Network>
  settings!: Table<Setting>
  wallets!: Table<WalletInternal>

  constructor(config: DatabaseConfig) {
    super(config.name)
    const stores = {
      accounts: 'id, [order+walletId], derivationIndex, order, publicKey, type, walletId',
      bookmarkAccounts: 'id, address, label, updatedAt',
      bookmarkTransactions: 'id, signature, label, updatedAt',
      // Per-address backfill cursor for the chain history reader.
      chainSyncState: 'address',
      // Composite key: the same signature can be cached for several watched
      // addresses; `timestamp` powers the per-address chronological read.
      chainTransactions: '[address+signature], address, timestamp',
      networks: 'id, name, type',
      settings: 'id, &key',
      wallets: 'id, name, order',
    }

    this.version(1).stores(stores)
    this.version(2).stores(stores).upgrade(migrateLegacyPlaintextWalletsToUnsecured)
    this.version(3).stores(stores)
    this.version(4).stores(stores).upgrade(migrateExternalWalletMarker)
    this.version(5).stores(stores)

    this.accounts.hook('reading', accountReadingHook)
    this.wallets.hook('reading', walletReadingHook)

    this.on('populate', async () => {
      await populate({ db: this, vault: createDbVault({ db: this }) })
    })
  }
}

function accountReadingHook(account: AccountInternal | undefined) {
  return account ? accountSanitizer(account) : account
}

function walletReadingHook(wallet: WalletInternal | undefined) {
  return wallet ? walletSanitizer(wallet) : wallet
}

// Wallets created for an external connection before `externalWallet` was
// persisted carry only an empty derivationPath. Backfill the marker so the
// empty-path heuristic can fade out: prefer the wallet-standard name stored
// on its Connected accounts, fall back to the (possibly truncated) name.
async function migrateExternalWalletMarker(transaction: Transaction): Promise<void> {
  const accounts = transaction.table<AccountInternal, string>('accounts')
  const wallets = transaction.table<WalletInternal, string>('wallets')
  const legacyWallets = await wallets
    .toCollection()
    .raw()
    .filter((wallet) => !wallet.externalWallet && wallet.derivationPath.length === 0)
    .toArray()

  for (const wallet of legacyWallets) {
    const walletAccounts = await accounts.where('walletId').equals(wallet.id).raw().toArray()
    const name = walletAccounts.find((account) => account.externalWallet)?.externalWallet ?? wallet.name
    await wallets.update(wallet.id, { externalWallet: name })
    for (const account of walletAccounts) {
      if (!account.externalWallet) {
        await accounts.update(account.id, { externalWallet: name })
      }
    }
  }
}

async function migrateLegacyPlaintextWalletsToUnsecured(transaction: Transaction): Promise<void> {
  const accounts = transaction.table<AccountInternal, string>('accounts')
  const wallets = transaction.table<WalletInternal, string>('wallets')
  const legacyWallets = await wallets.toCollection().raw().toArray()

  for (const wallet of legacyWallets) {
    if (!wallet.mnemonic || isEncryptedValue(wallet.mnemonic) || isWalletProtection(wallet.secret)) {
      continue
    }

    const protection = createUnsecuredWalletProtection()
    const key = await Dexie.waitFor(unlockUnsecuredWalletProtection({ protection }))
    await wallets.update(wallet.id, {
      mnemonic: await Dexie.waitFor(encryptWithVaultKey({ key, value: wallet.mnemonic })),
      secret: protection,
    })

    const walletAccounts = await accounts.where('walletId').equals(wallet.id).raw().toArray()
    for (const account of walletAccounts) {
      if (!account.secretKey || isEncryptedValue(account.secretKey)) {
        continue
      }
      await accounts.update(account.id, {
        secretKey: await Dexie.waitFor(encryptWithVaultKey({ key, value: account.secretKey })),
      })
    }
  }
}
