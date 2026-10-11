import type { Page } from '@playwright/test'
import { expect } from '@playwright/test'
import { testWalletMenuLabel, testWalletSeedPhrase } from '../fixtures/wallet.ts'
import { setupVaultPassword } from './vault.ts'

async function fillImportMnemonic(page: Page) {
  for (const [index, word] of testWalletSeedPhrase.entries()) {
    const name = (index + 1).toString()
    await page.getByRole('textbox', { exact: true, name }).click()
    await page.getByRole('textbox', { exact: true, name }).fill(word)
  }
}

// The index page groups entry paths into expandable option cards: 'I already
// have a wallet' opens a card whose inner action navigates to the import form.
async function navigateToImport(page: Page) {
  await page.getByRole('button', { name: 'I already have a wallet' }).click()
  await page.getByRole('button', { name: 'Import my 12 words' }).click()
}

export async function importExistingWallet(page: Page) {
  await page.goto('')
  await navigateToImport(page)
  await fillImportMnemonic(page)

  await page.getByRole('button', { name: 'Import wallet' }).click()
  await setupVaultPassword(page)
  await expect(page.getByTestId('wallet-menu-trigger')).toContainText(testWalletMenuLabel)
}

export async function importExistingWalletUnsecured(page: Page) {
  await page.goto('')
  await navigateToImport(page)
  await fillImportMnemonic(page)

  await page.getByText('Advanced protection').click()
  await page.getByRole('radio', { name: 'Unsecured' }).click()
  await page.getByLabel(/confirm this wallet will not be protected/).fill('UNSECURED')
  await page.getByRole('button', { name: 'Import wallet' }).click()
  await expect(page.getByRole('heading', { name: 'Create app password' })).toBeHidden()
  await expect(page.getByTestId('wallet-menu-trigger')).toContainText(testWalletMenuLabel)
}
