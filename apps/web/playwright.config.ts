import { defineConfig, devices } from '@playwright/test'

const isCi = Boolean(process.env['CI'])

export default defineConfig({
  forbidOnly: isCi,
  fullyParallel: true,
  // Bound the whole run in CI: a wedged worker/browser otherwise burns the
  // full job timeout with no output. A healthy run finishes in ~4 minutes.
  globalTimeout: isCi ? 20 * 60_000 : 0,
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'firefox',
      use: { ...devices['Desktop Firefox'] },
    },
    {
      name: 'webkit',
      use: { ...devices['Desktop Safari'] },
    },
    {
      name: 'Mobile Chrome',
      use: { ...devices['Pixel 5'] },
    },
    {
      name: 'Mobile Safari',
      use: { ...devices['iPhone 12'] },
    },
  ],
  // 'html' stays for the uploaded report; 'list' keeps the CI log readable so
  // a hang shows which test was running instead of staying silent.
  reporter: isCi ? [['list'], ['html']] : 'html',
  retries: isCi ? 2 : 0,
  testDir: './e2e',
  use: {
    baseURL: 'http://localhost:4173',
    trace: 'on-first-retry',
  },
  webServer: {
    command: 'bun e2e/web-server.ts',
    env: { VITE_ACTIVE_NETWORK_ID: 'networkLocalnet' },
    gracefulShutdown: { signal: 'SIGTERM', timeout: 10_000 },
    reuseExistingServer: false,
    timeout: 180_000,
    url: 'http://localhost:4173',
  },
  workers: isCi ? 1 : 3,
})
