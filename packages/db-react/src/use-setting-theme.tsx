import { useTranslation } from '@workspace/i18n'
import { useEffect } from 'react'
import { applyThemeClasses } from './resolve-theme.tsx'
import { useSetting } from './use-setting.tsx'

export function useSettingTheme() {
  const { t } = useTranslation('db-react')
  const [theme, setTheme] = useSetting('theme')
  const themeMap = {
    auto: t(($) => $.themeAuto),
    dark: t(($) => $.themeDark),
    jupiter: t(($) => $.themeJupiter),
    light: t(($) => $.themeLight),
  }
  const options = Object.entries(themeMap).map(([value, label]) => ({ label, value }))

  useEffect(() => {
    const apply = () => applyThemeClasses(theme)
    apply()
    // Re-apply when the OS preference flips while 'auto' is selected.
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    media.addEventListener('change', apply)
    return () => media.removeEventListener('change', apply)
  }, [theme])

  return {
    options,
    setTheme,
    theme,
  }
}
