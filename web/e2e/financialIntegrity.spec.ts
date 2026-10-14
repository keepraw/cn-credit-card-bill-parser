import { expect, test, type Page } from '@playwright/test'
import { SYNTHETIC_CCB_HTML } from '../tests/fixtures/ccbEml'
import { historyRow, workbookBytes } from '../tests/fixtures/legacyWorkbook'
import { LEGACY_UNIFIED_BILL_COLUMNS } from '../src/importers/legacyUnifiedBillV1'

async function prepareImport(page: Page) {
  await page.goto('/#/settings')
  await page.getByTestId('demo-toggle').uncheck()
  await page.goto('/#/import')
}

async function importHistory(page: Page, rows: unknown[][]) {
  const buffer = workbookBytes('统一账单', LEGACY_UNIFIED_BILL_COLUMNS, rows)
  await page.getByTestId('legacy-file-input').setInputFiles({ name: 'synthetic-history.xlsx',
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: Buffer.from(buffer) })
  await expect(page.getByTestId('legacy-preview')).toBeVisible()
}

test('keeps foreign settlement records but never reports mixed minor units as RMB', async ({ page }) => {
  await prepareImport(page)
  await importHistory(page, [
    historyRow({ 交易详情: '消费 合成人民币', 交易金额: 1, 入账金额: 1 }, 'unified'),
    historyRow({ 交易详情: '消费 合成日元', 交易币种: 'JPY', 交易金额: 100, 入账币种: 'JPY', 入账金额: 100 }, 'unified'),
  ])
  await page.getByTestId('legacy-confirm').click()
  await expect(page.getByTestId('legacy-preview')).toHaveCount(0)
  await page.goto('/#/dashboard')
  await expect(page.getByTestId('currency-summary-warning')).toContainText('JPY 1 笔')
  await expect(page.locator('.stat-value').first()).toHaveText('¥1.00')
  await page.reload()
  await expect(page.getByTestId('currency-summary-warning')).toContainText('未进行汇率换算')
  await page.goto('/#/transactions')
  await expect(page.locator('tbody tr')).toHaveCount(2)
})

test('rebuilds duplicate comparison after reload and warns about inclusive totals', async ({ page }) => {
  await prepareImport(page)
  await page.getByTestId('file-input').setInputFiles({ name: 'synthetic-native.html', mimeType: 'text/html', buffer: Buffer.from(SYNTHETIC_CCB_HTML) })
  await expect(page.getByTestId('import-row').first()).toContainText('解析成功')
  await importHistory(page, [historyRow({ 银行名称: '建设银行', 卡号: '5678', 交易日期: '2026-07-20', 入账日期: '2026-07-20',
    交易详情: '示例餐厅-消费测试店', 交易币种: 'USD', 交易金额: 18, 入账金额: 68 }, 'unified')])
  await expect(page.getByTestId('legacy-migration-review')).toBeVisible()
  await page.getByTestId('legacy-confirm').click()
  await expect(page.getByTestId('legacy-preview')).toHaveCount(0)
  await page.goto('/#/dashboard')
  await expect(page.getByTestId('duplicate-summary-warning')).toContainText('总额可能重复累计')
  await page.goto('/#/review')
  await page.getByRole('button', { name: /交易复核/ }).click()
  await page.getByTestId('duplicate-comparison').locator('summary').click()
  const comparison = page.getByTestId('duplicate-comparison')
  for (const text of ['USD 18.00', 'CNY 68.00', '原币金额', 'synthetic-native.html', 'synthetic-history.xlsx']) {
    await expect(comparison).toContainText(text)
  }
  await page.reload()
  await page.getByRole('button', { name: /交易复核/ }).click()
  await expect(comparison.locator('summary')).toContainText('1 笔候选')
  await page.goto('/#/transactions')
  await expect(page.locator('tbody tr')).toHaveCount(15)
})

test('invalid original installment amount cannot persist a shortened reconciled statement', async ({ page }) => {
  await prepareImport(page)
  const html = SYNTHETIC_CCB_HTML.replace('<td>CNY</td><td>900.00</td>', '<td>JPY</td><td>100.50</td>')
  await page.getByTestId('file-input').setInputFiles({ name: 'synthetic-invalid.html', mimeType: 'text/html', buffer: Buffer.from(html) })
  await expect(page.getByTestId('import-row').first()).toContainText('交易金额无效')
  await expect(page.getByTestId('import-row').first()).not.toContainText('解析成功')
  const counts = await page.evaluate(async () => {
    const url = '/src/db/db.ts'
    const { db } = await import(url)
    return { transactions: await db.transactions.count(), statements: await db.statements.count() }
  })
  expect(counts).toEqual({ transactions: 0, statements: 0 })
})
