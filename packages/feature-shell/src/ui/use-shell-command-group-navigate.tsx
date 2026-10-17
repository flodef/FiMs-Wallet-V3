import { useIsAdmin } from '@workspace/db-react/use-is-admin'
import { isEnabled } from '@workspace/flags'
import { useTranslation } from '@workspace/i18n'
import { useLocation, useNavigate } from 'react-router'
import type { ShellCommandGroup } from './use-shell-command-groups.tsx'

export function useShellCommandGroupNavigate(): ShellCommandGroup {
  const { t } = useTranslation('shell')
  const navigate = useNavigate()
  const { pathname } = useLocation()

  const isAdmin = useIsAdmin()

  const options: { label: string; path: string }[] = [
    {
      label: t(($) => $.labelPortfolio),
      path: '/portfolio',
    },
    {
      label: t(($) => $.labelExplorer),
      path: '/explorer',
    },
    ...(isAdmin ? [{ label: t(($) => $.labelTools), path: '/tools' }] : []),
    {
      label: t(($) => $.labelSettings),
      path: '/settings',
    },
  ]

  if (isEnabled('developerMode')) {
    options.push({
      label: t(($) => $.labelDevelopment),
      path: '/dev',
    })
  }

  return {
    commands: options.map(({ label, path }) => ({
      disabled: pathname.startsWith(path),
      handler: async () => {
        await navigate(path)
      },
      label: `${t(($) => $.commandNavigateTo)} ${label}`,
    })),
    label: t(($) => $.commandNavigate),
  }
}
