import { defaultExclude, defineConfig } from 'vitest/config'

export const sharedConfig = defineConfig({
  test: {
    environment: 'jsdom',
    exclude: [...defaultExclude, '**/*.integration.test.ts'],
    globals: true,
    // Dexie + vault crypto in a crowded worker pool can outlast the 5s
    // default — a fixed budget identical locally and in CI beats flakes.
    maxWorkers: process.env['CI'] ? 4 : 8,
    testTimeout: 20_000,
  },
})
