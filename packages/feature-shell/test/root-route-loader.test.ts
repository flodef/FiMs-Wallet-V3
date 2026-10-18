import 'fake-indexeddb/auto'

import { accountCreate } from '@workspace/db/account/account-create'
import type { DbContext } from '@workspace/db/db-context'
import { settingFindUnique } from '@workspace/db/setting/setting-find-unique'
import { settingSetValue } from '@workspace/db/setting/setting-set-value'
import {
  createDbContextTest,
  createPasswordTestVault,
  testAccountCreateInput,
  testWalletCreateInput,
} from '@workspace/db/test-helpers'
import { walletCreate } from '@workspace/db/wallet/wallet-create'
import { queryClient } from '@workspace/db-react/query-client'
import { beforeEach, describe, expect, it } from 'vitest'

import { rootRouteLoader } from '../src/data-access/root-route-loader.tsx'

// jsdom has no matchMedia — the loader calls applyThemeClasses on every
// pass; a stub is enough for these data-layer assertions.
Object.defineProperty(window, 'matchMedia', {
  value: (query: string) => ({
    addEventListener: () => {},
    matches: false,
    media: query,
    removeEventListener: () => {},
  }),
  writable: true,
})

const ctx: DbContext = createDbContextTest()
const loader = rootRouteLoader(ctx)
const args = (path: string) => ({ request: new Request(`http://localhost${path}`) }) as never

async function seedAccount() {
  const walletId = await walletCreate(ctx, testWalletCreateInput())
  return accountCreate(ctx, testAccountCreateInput({ walletId }))
}

describe('root-route-loader', () => {
  beforeEach(async () => {
    await ctx.db.accounts.clear()
    await ctx.db.settings.clear()
    await ctx.db.wallets.clear()
    await createPasswordTestVault(ctx)
    queryClient.clear()
  })

  describe('expected behavior', () => {
    it('should redirect to onboarding when no account exists', async () => {
      // ARRANGE
      expect.assertions(2)

      // ACT
      const result = await loader(args('/portfolio'))

      // ASSERT — react-router redirect() returns a Response
      expect(result).toBeInstanceOf(Response)
      expect(new URL((result as Response).headers.get('Location') ?? '', 'http://x').pathname).toBe('/onboarding')
    })

    it('should repair a dangling activeAccountId instead of looping', async () => {
      // ARRANGE — activeAccountId points at a deleted account.
      expect.assertions(1)
      const accountId = await seedAccount()
      await settingSetValue(ctx, 'activeAccountId', 'ghost-account-id')

      // ACT
      await loader(args('/portfolio'))

      // ASSERT — the loader persists the surviving account, no redirect
      expect((await settingFindUnique(ctx, 'activeAccountId'))?.value).toBe(accountId)
    })

    it('should force mainnet for a non-admin on devnet', async () => {
      // ARRANGE
      expect.assertions(1)
      await seedAccount()
      await settingSetValue(ctx, 'activeNetworkId', 'networkDevnet')

      // ACT
      await loader(args('/portfolio'))

      // ASSERT — network rows carry ids like networkMainnet, the
      // solana:* strings are the `type` discriminant.
      expect((await settingFindUnique(ctx, 'activeNetworkId'))?.value).toBe('networkMainnet')
    })
  })
})
