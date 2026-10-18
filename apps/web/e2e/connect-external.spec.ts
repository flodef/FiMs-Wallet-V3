import { expect, test } from '@playwright/test'

// Smoke: a wallet-standard extension connects from onboarding and the app
// opens straight into the wallet view (the onboarding loop regression).
// The fake wallet registers itself through the standard window event before
// the app boots — the same mechanism a real extension uses.
const FAKE_ADDRESS = '5F86TNSTre3CYwZd1wELsGQGhqG2HkN3d8zxhbyBSnzm'

test.beforeEach(async ({ page }) => {
  await page.addInitScript(
    ([addressB58]: string[]) => {
      const wallet = {
        accounts: [],
        chains: ['solana:mainnet'],
        features: {
          'standard:connect': {
            connect: () => ({
              accounts: [
                {
                  address: addressB58,
                  chains: ['solana:mainnet'],
                  features: ['standard:connect'],
                  label: 'E2E fake account',
                  publicKey: new Uint8Array(32).fill(7),
                },
              ],
            }),
            version: '1.0.0',
          },
        },
        icon: 'data:image/svg+xml;base64,PHN2Zy8+',
        name: 'E2E External Wallet',
        version: '1.0.0',
      }
      window.addEventListener('wallet-standard:app-ready', (event) => {
        const detail = (event as CustomEvent<{ register: (w: unknown[]) => void }>).detail
        detail.register([wallet])
      })
    },
    [FAKE_ADDRESS],
  )
})

test('onboarding - connect an external wallet opens the app', async ({ page }) => {
  await page.goto('/onboarding')
  await page.getByText('E2E External Wallet').click()
  await page.getByRole('button', { name: /connect/i }).click()
  await expect(page).toHaveURL(/\/portfolio/)
})
