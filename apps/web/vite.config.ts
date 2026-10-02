import { cloudflare } from '@cloudflare/vite-plugin'
import { sharedConfig } from '@workspace/config-vite'
import { defineConfig, mergeConfig } from 'vite'

export default mergeConfig(
  sharedConfig,
  defineConfig({
    build: {
      rollupOptions: {
        output: {
          // Split the single ~1 MB entry chunk by dependency family so browsers
          // download them in parallel and cache them independently.
          manualChunks(id: string) {
            if (!id.includes('node_modules')) return
            if (/[\\/]node_modules[\\/](react|react-dom|scheduler)[\\/]/.test(id)) return 'vendor-react'
            if (/[\\/]node_modules[\\/](i18next|react-i18next|i18next-[^/\\]+)[\\/]/.test(id)) return 'vendor-i18n'
            // No catch-all or broad family split: hoisting deps into shared
            // vendor chunks would pull lazy-only code into the entry and make
            // first load heavier.
            return undefined
          },
        },
      },
    },
    // Cloudflare plugin only for the Workers build; Vercel builds a plain SPA.
    plugins: process.env['VERCEL'] ? [] : [cloudflare()],
  }),
)
