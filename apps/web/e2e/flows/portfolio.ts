import { expect, type Page } from '@playwright/test'

export async function burnToken(page: Page, mint: string) {
  await page.goto('/#/portfolio/tokens')

  const tokenLink = page.locator(`a[href="#/modals/send/${mint}"]`)
  await expect(tokenLink).toBeVisible({ timeout: 60_000 })

  const tokenRow = tokenLink.locator('xpath=..')
  await tokenRow.locator('button').click()
  await page.getByRole('menuitem', { name: 'Burn tokens' }).click()

  await expect(page).toHaveURL(/#\/modals\/burn\//)
  const amountInput = page.locator('input[type="number"]')
  await expect(amountInput).toHaveValue('1000')
  await amountInput.fill('1')
  // Burn requires a typed confirmation — the expected word is carried on the
  // input itself (token symbol when known, else BURN).
  const confirmInput = page.locator('input[data-confirm-value]')
  await confirmInput.fill((await confirmInput.getAttribute('data-confirm-value')) ?? 'BURN')
  await page.getByRole('button', { name: 'Burn' }).click()

  await expect(page.getByText('Transaction complete!')).toBeVisible({ timeout: 60_000 })
}
