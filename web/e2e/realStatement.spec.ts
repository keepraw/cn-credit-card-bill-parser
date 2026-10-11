import { existsSync } from 'node:fs'
import { expect, test } from '@playwright/test'

/**
 * End-to-end import of the two private sample statements.
 *
 * Real statements are never committed. Point the environment at your own copies:
 *
 *   $env:CCB_REAL_BOC_PDF = "D:\账单\中国银行....pdf"
 *   $env:CCB_REAL_BOCOM_EML = "D:\账单\交通银行....eml"
 *   npm run test:e2e -- e2e/realStatement.spec.ts
 *
 * Skipped automatically when the variables are not set.
 */

const bocPath = process.env.CCB_REAL_BOC_PDF ?? ''
const bocomPath = process.env.CCB_REAL_BOCOM_EML ?? ''

test.describe('Real statement import', () => {
  test.skip(!bocPath || !existsSync(bocPath), 'CCB_REAL_BOC_PDF 未设置')

  test('imports the Bank of China PDF and balances', async ({ page }) => {
    await page.goto('/#/settings')
    const toggle = page.getByTestId('demo-toggle')
    await expect(toggle).toBeVisible({ timeout: 20_000 })
    if (await toggle.isChecked()) await toggle.uncheck()

    await page.goto('/#/import')
    await page.setInputFiles('[data-testid="file-input"]', bocPath)

    const row = page.getByTestId('import-row').first()
    await expect(row).toBeVisible({ timeout: 60_000 })
    await expect(row).toContainText('解析成功')
    await expect(row).toContainText('对账通过')
    await expect(row).toContainText('中国银行')

    await page.goto('/#/transactions')
    await expect(page.getByTestId('transactions-table')).toBeVisible()
    await expect(page.getByTestId('transactions-table').locator('tbody tr')).toHaveCount(8)
  })
})

test.describe('Real statement import', () => {
  test.skip(!bocomPath || !existsSync(bocomPath), 'CCB_REAL_BOCOM_EML 未设置')

  test('imports the Bank of Communications EML and balances', async ({ page }) => {
    await page.goto('/#/settings')
    const toggle = page.getByTestId('demo-toggle')
    await expect(toggle).toBeVisible({ timeout: 20_000 })
    if (await toggle.isChecked()) await toggle.uncheck()

    await page.goto('/#/import')
    await page.setInputFiles('[data-testid="file-input"]', bocomPath)

    const row = page.getByTestId('import-row').first()
    await expect(row).toBeVisible({ timeout: 60_000 })
    await expect(row).toContainText('解析成功')
    await expect(row).toContainText('对账通过')
    await expect(row).toContainText('交通银行')

    await page.goto('/#/transactions')
    await expect(page.getByTestId('transactions-table').locator('tbody tr')).toHaveCount(21)
  })
})