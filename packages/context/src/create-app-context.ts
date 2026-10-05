import { createDb } from '@workspace/db/create-db'
import { createDbVault } from '@workspace/db/create-db-vault'
import type { Database } from '@workspace/db/database'
import type { AppContext } from './app-context.ts'

// The IndexedDB name stays 'samui-wallet': renaming it would orphan every
// existing install's local database (accounts, wallets, cached chain data).
export function createAppContext(db: Database = createDb({ name: 'samui-wallet' })): AppContext {
  return { db, vault: createDbVault({ db }) }
}
