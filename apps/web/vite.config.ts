import { cloudflare } from '@cloudflare/vite-plugin'
import { sharedConfig } from '@workspace/config-vite'
import { defineConfig, mergeConfig } from 'vite'

export default mergeConfig(
  sharedConfig,
  defineConfig({
    // Cloudflare plugin only for the Workers build; Vercel builds a plain SPA.
    plugins: process.env['VERCEL'] ? [] : [cloudflare()],
  }),
)
