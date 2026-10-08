import { useAccountActive } from '@workspace/db-react/use-account-active'
import { useNetworkActive } from '@workspace/db-react/use-network-active'
import { useSetting } from '@workspace/db-react/use-setting'
import { envAdminAddresses } from '@workspace/env/env'
import { FimsFeatureGasTopup } from '@workspace/feature-fims/fims-feature-gas-topup'
import { FimsFeatureRentReclaim } from '@workspace/feature-fims/fims-feature-rent-reclaim'
import { FimsFeatureSolExcess } from '@workspace/feature-fims/fims-feature-sol-excess'
import { useTranslation } from '@workspace/i18n'
import { UiIcon } from '@workspace/ui/components/ui-icon'
import type { UiIconName } from '@workspace/ui/components/ui-icon-map'
import { getColorByName } from '@workspace/ui/lib/get-initials-colors'
import { cn } from '@workspace/ui/lib/utils'
import { useMemo } from 'react'
import { NavLink, Outlet } from 'react-router'
import { ShellUiBetaBanner } from './shell-ui-beta-banner.tsx'
import { ShellUiCommandMenu } from './shell-ui-command-menu.tsx'
import { ShellUiHelpDemo } from './shell-ui-help-demo.tsx'
import { ShellUiMenu } from './shell-ui-menu.tsx'
import { ShellUiMenuActions } from './shell-ui-menu-actions.tsx'

export interface ShellLayoutLink {
  icon: UiIconName
  label: string
  to: string
}

export function ShellUiLayout() {
  const activeAccount = useAccountActive()
  const activeNetwork = useNetworkActive()
  const [wallpaper] = useSetting('themeWallpaper')
  const { border } = useMemo(() => getColorByName(activeNetwork.color ?? 'green'), [activeNetwork])
  const { t } = useTranslation('shell')
  const isAdmin = envAdminAddresses().includes(activeAccount.publicKey)
  const links: ShellLayoutLink[] = [
    { icon: 'portfolio', label: t(($) => $.labelPortfolio), to: '/portfolio' },
    { icon: 'handCoins', label: t(($) => $.labelFims), to: '/fims' },
    { icon: 'explorer', label: t(($) => $.labelExplorer), to: '/explorer' },
    // Raw protocol tooling is admin-only — not a place for regular users.
    ...(isAdmin ? [{ icon: 'tools' as const, label: t(($) => $.labelTools), to: '/tools' }] : []),
    { icon: 'settings', label: t(($) => $.labelSettings), to: '/settings' },
  ]

  return (
    <div className="relative flex h-full flex-col items-stretch justify-between">
      {wallpaper ? (
        <>
          <div
            aria-hidden
            className="absolute inset-0 -z-10 bg-center bg-cover"
            style={{ backgroundImage: `url(${wallpaper})` }}
          />
          {/* Readability scrim over the custom wallpaper. */}
          <div aria-hidden className="absolute inset-0 -z-10 bg-background/75" />
        </>
      ) : null}
      <ShellUiCommandMenu />
      {/* Proactive FiMs prompts only make sense on mainnet: the quotes and
          conversions go through Jupiter, and an auto-open dialog on
          devnet/localnet breaks scripted flows (e2e) and nags testers. */}
      {activeNetwork.type === 'solana:mainnet' ? (
        <>
          <FimsFeatureRentReclaim />
          <FimsFeatureGasTopup />
          <FimsFeatureSolExcess />
        </>
      ) : null}
      <header
        className={cn('flex items-center justify-between bg-secondary/30', {
          [`border-b-2 ${border}`]: !!activeNetwork.color,
        })}
      >
        <ShellUiMenu />
        <div className="flex items-center gap-1 pr-2">
          <ShellUiHelpDemo />
          <ShellUiMenuActions />
        </div>
      </header>
      <ShellUiBetaBanner />
      <main className="flex-1 overflow-y-auto p-1 md:p-2 lg:p-4">
        <Outlet />
      </main>
      <footer className="flex items-center justify-between bg-secondary/30 pb-[env(safe-area-inset-bottom)]">
        {links.map(({ icon, label, to }) => (
          <NavLink
            className={({ isActive }) =>
              cn('flex flex-1 flex-col items-center gap-1 truncate pt-2 pb-1 text-xs md:gap-2 md:text-md', {
                'bg-primary/15 font-semibold text-primary': isActive,
              })
            }
            key={to}
            prefetch="viewport"
            to={to}
          >
            <UiIcon className="size-4 md:size-6" icon={icon} />
            {label}
          </NavLink>
        ))}
      </footer>
    </div>
  )
}
