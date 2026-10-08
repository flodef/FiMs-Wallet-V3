import { useAccountActive } from '@workspace/db-react/use-account-active'
import { envAdminAddresses } from '@workspace/env/env'
import { isEnabled } from '@workspace/flags'
import { useTranslation } from '@workspace/i18n'
import { useLocation, useNavigate } from 'react-router'
import type { ShellCommandGroup } from './use-shell-command-groups.tsx'

export function useShellCommandGroupNavigate(): ShellCommandGroup {
  const { t } = useTranslation('shell')
  const navigate = useNavigate()
  const { pathname } = useLocation()

  const account = useAccountActive()
  const isAdmin = envAdminAddresses().includes(account.publicKey)

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
