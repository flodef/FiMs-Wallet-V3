import { cloudflare } from '@cloudflare/vite-plugin'
import { sharedConfig } from '@workspace/config-vite'
import { defineConfig, mergeConfig } from 'vite'

export default mergeConfig(
  sharedConfig,
  defineConfig({
    // Note: manualChunks splitting was reverted — splitting react/i18next into
    // separate vendor chunks created a circular chunk dependency: vendor-i18n
    // evaluated createContext before vendor-react initialized, blanking the app.
    // Route-level lazy chunks already provide code splitting.
    // Cloudflare plugin only for the Workers build; Vercel builds a plain SPA.
    plugins: process.env['VERCEL'] ? [] : [cloudflare()],
  }),
)
