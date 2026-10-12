import { useTranslation } from '@workspace/i18n'
import { useEffect } from 'react'
import { applyThemeClasses } from './resolve-theme.tsx'
import { useSetting } from './use-setting.tsx'

export function useSettingTheme() {
  const { t } = useTranslation('db-react')
  const [storedTheme, setTheme] = useSetting('theme')
  // Legacy 'jupiter' values display as 'dark' — the Jupiter palette became the
  // dark theme. Writes from now on only store auto|dark|light.
  const theme = storedTheme === 'jupiter' ? 'dark' : storedTheme
  const themeMap = {
    auto: t(($) => $.themeAuto),
    dark: t(($) => $.themeDark),
    light: t(($) => $.themeLight),
  }
  const options = Object.entries(themeMap).map(([value, label]) => ({ label, value }))

  useEffect(() => {
    const apply = () => applyThemeClasses(storedTheme)
    apply()
    // Re-apply when the OS preference flips while 'auto' is selected.
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    media.addEventListener('change', apply)
    return () => media.removeEventListener('change', apply)
  }, [storedTheme])

  return {
    options,
    setTheme,
    theme,
  }
}
