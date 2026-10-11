// 'auto' tracks the OS dark/light preference; anything unknown falls back to
// dark (the historical default). 'jupiter' is a dark variant — callers also
// need the 'dark' class for it, see applyThemeClasses.
export type ThemeSetting = 'auto' | 'dark' | 'jupiter' | 'light' | null | string | undefined

function systemPrefersDark(): boolean {
  return typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches
}

export function resolveTheme(stored: ThemeSetting): 'dark' | 'jupiter' | 'light' {
  if (!stored || stored === 'auto') {
    return systemPrefersDark() ? 'dark' : 'light'
  }
  return stored === 'jupiter' || stored === 'light' ? stored : 'dark'
}

export function applyThemeClasses(stored: ThemeSetting) {
  const theme = resolveTheme(stored)
  document.documentElement.classList.toggle('dark', theme !== 'light')
  document.documentElement.classList.toggle('jupiter', theme === 'jupiter')
}
