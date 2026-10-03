import { useTranslation } from '@workspace/i18n'
import { useEffect } from 'react'
import { useSetting } from './use-setting.tsx'

export function useSettingTheme() {
  const { t } = useTranslation('db-react')
  const [theme, setTheme] = useSetting('theme')
  const themeMap = {
    dark: t(($) => $.themeDark),
    jupiter: t(($) => $.themeJupiter),
    light: t(($) => $.themeLight),
  }
  const options = Object.entries(themeMap).map(([value, label]) => ({ label, value }))

  useEffect(() => {
    // 'jupiter' is a dark variant: it carries .dark so dark: variants still
    // apply, plus .jupiter for its own palette overrides.
    document.documentElement.classList.toggle('dark', theme !== 'light')
    document.documentElement.classList.toggle('jupiter', theme === 'jupiter')
  }, [theme])

  return {
    options,
    setTheme,
    theme,
  }
}
