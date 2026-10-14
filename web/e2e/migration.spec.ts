import { expect, test } from '@playwright/test'
import { historyRow, workbookBytes } from '../tests/fixtures/legacyWorkbook'
import { LEGACY_UNIFIED_BILL_COLUMNS } from '../src/importers/legacyUnifiedBillV1'

test('imports unified history with repeats and future-date review in real IndexedDB', async ({ page }) => {
  await page.goto('/#/settings')
  await page.getByTestId('demo-toggle').uncheck()
  await page.goto('/#/import')
  const upload = { name: 'synthetic-history.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    buffer: Buffer.from(workbookBytes('统一账单', LEGACY_UNIFIED_BILL_COLUMNS, [
      historyRow({}, 'unified'), historyRow({}, 'unified'),
      historyRow({ 交易日期: '2096-02-29', 入账日期: '2096-03-01' }, 'unified'),
    ])) }
  await page.getByTestId('legacy-file-input').setInputFiles(upload)
  await expect(page.getByTestId('legacy-preview-summary')).toContainText('可导入 3 笔')
  await expect(page.getByText('发现未来日期，原值保留，不自动改年份：')).toBeVisible()
  await page.getByTestId('legacy-confirm').click()
  await expect(page.getByTestId('legacy-preview')).toHaveCount(0)
  await page.goto('/#/transactions')
  await expect(page.locator('tbody tr')).toHaveCount(3)
  await expect(page.locator('tbody')).toContainText('2096-02-29')
  await page.reload()
  await expect(page.locator('tbody tr')).toHaveCount(3)
  await page.goto('/#/import')
  await page.getByTestId('legacy-file-input').setInputFiles(upload)
  await expect(page.getByText('该文件此前已导入，确认后不会产生重复交易。')).toBeVisible()
  await page.getByTestId('legacy-confirm').click()
  await expect(page.getByTestId('legacy-preview')).toHaveCount(0)
  await page.goto('/#/transactions')
  await expect(page.locator('tbody tr')).toHaveCount(3)
})

test('measures 100000 synthetic transactions in Chromium and real IndexedDB', async ({ page }) => {
  test.setTimeout(180_000)
  await page.goto('/')
  const metrics = await page.evaluate(async () => {
    const fixturesUrl = '/tests/fixtures/identity.ts'
    const repositoryUrl = '/src/db/repository.ts'
    const databaseUrl = '/src/db/db.ts'
    const { ingestSynthetic } = await import(fixturesUrl)
    const { persistImportResults, readSnapshot } = await import(repositoryUrl)
    const { db } = await import(databaseUrl)
    const started = performance.now()
    const first = ingestSynthetic(Array(100_000).fill('消费 合成性能商户'), 'browser-perf-first')
    const planMs = performance.now() - started
    const writing = performance.now()
    await persistImportResults([first])
    const writeMs = performance.now() - writing
    const reading = performance.now()
    const snapshot = await readSnapshot()
    const readMs = performance.now() - reading
    const overlapping = performance.now()
    const second = ingestSynthetic(Array(100_001).fill('消费 合成性能商户'), 'browser-perf-overlap', snapshot)
    const overlapPlanMs = performance.now() - overlapping
    await persistImportResults([second])
    const rows = await db.transactions.toArray()
    return { planMs, writeMs, readMs, overlapPlanMs, totalMs: performance.now() - started,
      count: rows.length, newOccurrences: second.inserted.length,
      distinctIds: new Set(rows.map((row: { id: string }) => row.id)).size,
      totalMinor: rows.reduce((sum: number, row: { settlementAmountMinor: number }) => sum + row.settlementAmountMinor, 0) }
  })
  console.info(`synthetic Chromium/IndexedDB benchmark: ${JSON.stringify(metrics)}`)
  expect(metrics.count).toBe(100_001)
  expect(metrics.distinctIds).toBe(100_001)
  expect(metrics.newOccurrences).toBe(1)
  expect(metrics.totalMinor).toBe(100_001 * 12880)
  await page.reload()
  const count = await page.evaluate(async () => {
    const url = '/src/db/db.ts'
    const { db } = await import(url)
    return db.transactions.count()
  })
  expect(count).toBe(100_001)
})
