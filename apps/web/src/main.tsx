import '@workspace/i18n'
import { ShellFeature } from '@workspace/feature-shell/shell-feature'
import { lazy, StrictMode, Suspense } from 'react'
import { createRoot } from 'react-dom/client'

const root = document.getElementById('root')
if (!root) {
  throw new Error('Root element not found')
}

// Same deployment serves both sites: fims.fi hosts the landing page, the
// wallet domains host the wallet app.
// Keep the marketing landing off the wallet origins: serving both from one
// origin blurs the trust boundary a phishing page could exploit.
const LANDING_HOSTS = new Set(['fims.fi', 'www.fims.fi'])
const isLandingHost = LANDING_HOSTS.has(window.location.hostname)
const LandingPage = lazy(() => import('./landing/landing-page.tsx').then((m) => ({ default: m.LandingPage })))

// PWA: register the passthrough service worker so the app is installable.
// Dev would cache-bust oddly, so prod only.
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {})
  })
}

createRoot(root).render(
  <StrictMode>
    {isLandingHost ? (
      <Suspense fallback={null}>
        <LandingPage />
      </Suspense>
    ) : (
      <ShellFeature />
    )}
  </StrictMode>,
)
