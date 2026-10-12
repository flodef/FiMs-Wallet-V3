// 'auto' tracks the OS dark/light preference; anything unknown falls back to
// dark (the historical default). 'jupiter' is a legacy value for the dark
// palette — the Jupiter-inspired theme became the app's dark/light pair.
export type ThemeSetting = 'auto' | 'dark' | 'jupiter' | 'light' | null | string | undefined

function systemPrefersDark(): boolean {
  return typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches
}

export function resolveTheme(stored: ThemeSetting): 'dark' | 'light' {
  if (!stored || stored === 'auto') {
    return systemPrefersDark() ? 'dark' : 'light'
  }
  return stored === 'light' ? 'light' : 'dark'
}

export function applyThemeClasses(stored: ThemeSetting) {
  document.documentElement.classList.toggle('dark', resolveTheme(stored) === 'dark')
}
