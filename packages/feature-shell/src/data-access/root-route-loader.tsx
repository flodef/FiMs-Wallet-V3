import type { AppContext } from '@workspace/context/app-context'
import {
  hasAdminAccount,
  resolveActiveAccount,
  resolveAllowedNetwork,
  settingValue,
} from '@workspace/db/session/resolve-session'
import { settingSetValue } from '@workspace/db/setting/setting-set-value'
import { invalidateWalletGraph } from '@workspace/db-react/invalidate-wallet-graph'
import { applyThemeClasses } from '@workspace/db-react/resolve-theme'
import { rootLoader } from '@workspace/db-react/root-loader'
import { envAdminAddresses } from '@workspace/env/env'
import { demoGetState } from '@workspace/feature-onboarding/demo/demo-store'
import { i18n, resolveLanguage } from '@workspace/i18n'
import { type LoaderFunctionArgs, redirect } from 'react-router'
import { redirectToOnboarding } from './redirect-to-onboarding.tsx'

export function rootRouteLoader(ctx: AppContext) {
  return async (args: LoaderFunctionArgs) => {
    const url = new URL(args.request.url)
    const pathname = url.pathname

    const loaded = await rootLoader(ctx)
    const { accounts, networks, wallets } = loaded
    let { settings } = loaded
    const writeSetting = async (key: 'activeAccountId' | 'activeNetworkId', value: string) => {
      await settingSetValue(ctx, key, value)
      // Never mutate the cached rows in place — return a fresh array. A
      // first-time write has no row to patch, so append a synthetic one:
      // the returned snapshot must reflect what was just persisted.
      const now = new Date()
      settings = settings.some((setting) => setting.key === key)
        ? settings.map((setting) => (setting.key === key ? { ...setting, value } : setting))
        : [...settings, { createdAt: now, id: `pending:${key}`, key, updatedAt: now, value }]
    }

    // activeAccountId can point at a deleted account (external wallet
    // disconnected while active, …) or simply be unset while accounts exist —
    // reassign it instead of letting the app loop on a stale id.
    const active = resolveActiveAccount({
      accounts,
      activeAccountId: settingValue(settings, 'activeAccountId'),
      wallets,
    })
    if (active.repaired && active.account) {
      await writeSetting('activeAccountId', active.account.id)
    }
    if (!active.account && !pathname.startsWith('/onboarding')) {
      return redirectToOnboarding()
    }

    if (!networks.length) {
      return redirect('/settings/networks')
    }
    // Public test networks are an admin/debug feature: outside the guided
    // demo a non-admin is always brought back to mainnet.
    const network = resolveAllowedNetwork({
      activeNetworkId: settingValue(settings, 'activeNetworkId'),
      demo: demoGetState().active,
      isAdmin: hasAdminAccount(accounts, envAdminAddresses()),
      networks,
    })
    if (network.repaired && network.network) {
      await writeSetting('activeNetworkId', network.network.id)
    }
    if (active.repaired || network.repaired) {
      await invalidateWalletGraph(ctx)
    }

    applyThemeClasses(settingValue(settings, 'theme'))
    await i18n.changeLanguage(resolveLanguage(settingValue(settings, 'language')))

    return { ...loaded, settings }
  }
}
