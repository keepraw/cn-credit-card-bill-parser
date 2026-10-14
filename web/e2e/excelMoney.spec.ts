import { expect, test } from '@playwright/test'
import { LEGACY_KEEPRAW_COLUMNS } from '../src/importers/legacyKeeprawExportV1'
import { LEGACY_UNIFIED_COLUMNS } from '../src/importers/legacyPythonExportV1'
import { LEGACY_UNIFIED_BILL_COLUMNS } from '../src/importers/legacyUnifiedBillV1'
import { historyRow, workbookBytes } from '../tests/fixtures/legacyWorkbook'

const FORMATS = [
  ['标准字段', LEGACY_UNIFIED_COLUMNS, 'python', 'transaction_amount', 'settlement_amount'],
  ['交易明细', LEGACY_KEEPRAW_COLUMNS, 'keepraw', '交易金额', '结算金额'],
  ['统一账单', LEGACY_UNIFIED_BILL_COLUMNS, 'unified', '交易金额', '入账金额'],
] as const

for (const [sheet, headers, format, transactionColumn, settlementColumn] of FORMATS) {
  test(`${sheet}: imports Excel numeric/text money and shows invalid monetary legs explicitly`, async ({ page }) => {
    await page.goto('/#/settings')
    await page.getByTestId('demo-toggle').uncheck()
    await page.goto('/#/import')
    const transactionCurrencyColumn = format === 'python' ? 'transaction_currency' : '交易币种'
    const settlementCurrencyColumn = format === 'python' ? 'settlement_currency' : format === 'unified' ? '入账币种' : '结算币种'
    const currencies = ['TRY', 'MYR', 'PHP', 'IDR', 'CNY', 'CNY', 'CNY', 'TRY']
    const amounts = [
      [246.81, 135.79], [2.73, 8.46], ['246.81', '135.79'],
      [246, 135], [-617.24, -324.69], [0, 0],
      [10 + 1.12, 11.129999999999999], [246.81, 135.79],
    ]
    const rows = amounts.map(([transaction, settlement], index) =>
      historyRow({ [transactionColumn]: transaction, [settlementColumn]: settlement,
        [transactionCurrencyColumn]: currencies[index], [settlementCurrencyColumn]: currencies[index] }, format))
    rows.push(historyRow({ [transactionColumn]: 'abc' }, format), historyRow({ [settlementColumn]: null }, format))
    await page.getByTestId('legacy-file-input').setInputFiles({
      name: `synthetic-money-${format}.xlsx`,
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      buffer: Buffer.from(workbookBytes(sheet, headers, rows)),
    })
    await expect(page.getByTestId('legacy-preview-summary')).toContainText(/共 10 行数据，可导入 8 笔，\s*异常 2 行/)
    const exclusions = page.getByTestId('legacy-preview').locator('details')
    await exclusions.locator('summary').click()
    await expect(exclusions).toContainText('第 10 行：')
    await expect(exclusions).toContainText('第 11 行：')
    if (format !== 'unified') {
      await expect(exclusions).toContainText('交易金额无法解析，不以结算金额替代')
      await expect(exclusions).toContainText('结算金额无法解析')
    } else {
      await expect(exclusions).toContainText('交易金额或入账金额无法精确转换为最小货币单位')
    }
    await page.getByTestId('legacy-confirm').click()
    await expect(page.getByTestId('legacy-preview')).toHaveCount(0)
    await page.goto('/#/transactions')
    await expect(page.locator('tbody tr')).toHaveCount(8)
    await page.reload()
    await expect(page.locator('tbody tr')).toHaveCount(8)
    const stored = await page.evaluate(async () => {
      const url = '/src/db/db.ts'
      const { db } = await import(url)
      const rows = await db.transactions.toArray()
      return {
        distinctIds: new Set(rows.map((row: { id: string }) => row.id)).size,
        money: rows.sort((a: { sourceRow: number }, b: { sourceRow: number }) => a.sourceRow - b.sourceRow)
          .map((row: { sourceRow: number; transactionAmountMinor: number; settlementAmountMinor: number }) =>
            [row.sourceRow, row.transactionAmountMinor, row.settlementAmountMinor]),
        currencies: rows.map((row: { transactionCurrency: string; settlementCurrency: string }) =>
          [row.transactionCurrency, row.settlementCurrency]),
      }
    })
    expect(stored).toEqual({ distinctIds: 8, money: [
      [2, 24681, 13579], [3, 273, 846], [4, 24681, 13579], [5, 24600, 13500],
      [6, -61724, -32469], [7, 0, 0], [8, 1112, 1113], [9, 24681, 13579],
    ], currencies: currencies.map((currency) => [currency, currency]) })
  })
}
