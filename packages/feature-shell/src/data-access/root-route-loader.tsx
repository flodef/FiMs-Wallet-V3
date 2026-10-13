import type { AppContext } from '@workspace/context/app-context'
import { settingSetValue } from '@workspace/db/setting/setting-set-value'
import { applyThemeClasses } from '@workspace/db-react/resolve-theme'
import { rootLoader } from '@workspace/db-react/root-loader'
import { i18n, resolveLanguage } from '@workspace/i18n'
import { type LoaderFunctionArgs, redirect } from 'react-router'
import { redirectToOnboarding } from './redirect-to-onboarding.tsx'

export function rootRouteLoader(ctx: AppContext) {
  return async (args: LoaderFunctionArgs) => {
    const url = new URL(args.request.url)
    const pathname = url.pathname

    const result = await rootLoader(ctx)
    const { accounts, networks, settings } = result

    const activeAccountId = settings.find((s) => s.key === 'activeAccountId')?.value
    let activeAccount = activeAccountId ? accounts.find((account) => account.id === activeAccountId) : null

    // activeAccountId can point at a deleted account (external wallet
    // disconnected while active, …) or simply be unset while accounts
    // exist — reassign it instead of letting the app loop on a stale id.
    const fallback = accounts[0]
    if (!activeAccount && fallback) {
      activeAccount = fallback
      await settingSetValue(ctx, 'activeAccountId', fallback.id)
    }
    if (!activeAccount && !pathname.startsWith('/onboarding')) {
      return redirectToOnboarding()
    }

    if (!networks.length) {
      return redirect('/settings/networks')
    }
    const theme = settings.find((s) => s.key === 'theme')?.value
    applyThemeClasses(theme)

    const language = settings.find((s) => s.key === 'language')?.value
    await i18n.changeLanguage(resolveLanguage(language))

    return result
  }
}
