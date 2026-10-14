import { beforeEach, describe, expect, it } from 'vitest'
import { db } from '../src/db/db'
import { persistLegacyImport, readSnapshot } from '../src/db/repository'
import { planLegacyImport, previewLegacyWorkbook } from '../src/importers/legacyImport'
import { LEGACY_UNIFIED_BILL_COLUMNS, detectUnifiedBillShape } from '../src/importers/legacyUnifiedBillV1'
import { LEGACY_UNIFIED_COLUMNS } from '../src/importers/legacyPythonExportV1'
import { LEGACY_KEEPRAW_COLUMNS } from '../src/importers/legacyKeeprawExportV1'
import { parseAmountToMinor } from '../src/core/money'
import { historyRow, workbookBytes } from './fixtures/legacyWorkbook'
import { EMPTY_SNAPSHOT } from './fixtures/identity'

const preview = (buffer: ArrayBuffer, fileHash = 'unified', existing = EMPTY_SNAPSHOT) =>
  previewLegacyWorkbook(buffer, { fileName: 'synthetic-history.xlsx', fileSize: buffer.byteLength, fileHash }, existing)

beforeEach(async () => { await db.delete(); await db.open() })

describe('strict named unified-bill compatibility', () => {
  it.each(LEGACY_UNIFIED_BILL_COLUMNS)('rejects missing header %s', (column) => {
    expect(detectUnifiedBillShape(LEGACY_UNIFIED_BILL_COLUMNS.filter((name) => name !== column))).toBeNull()
  })

  it('rejects renamed sheets, alias guesses and duplicate headers', async () => {
    await expect(preview(workbookBytes('other', LEGACY_UNIFIED_BILL_COLUMNS, [historyRow({}, 'unified')]))).rejects.toThrow()
    const headers = [...LEGACY_UNIFIED_BILL_COLUMNS].map((name) => name === '银行名称' ? '银行' : name)
    await expect(preview(workbookBytes('统一账单', headers, [historyRow({}, 'unified')]))).rejects.toThrow()
    expect(detectUnifiedBillShape([...LEGACY_UNIFIED_BILL_COLUMNS, '入账金额'])).toBeNull()
  })

  it('preserves occurrences, signed legs, currencies, dates and provenance through persistence', async () => {
    const buffer = workbookBytes('统一账单', LEGACY_UNIFIED_BILL_COLUMNS, [
      historyRow({}, 'unified'), historyRow({}, 'unified'),
      historyRow({ 卡号: '****0007', 交易日期: 45296, 入账日期: '2024-01-06', 交易详情: '退款 合成商户',
        交易币种: 'USD', 交易金额: '-10.25', 入账币种: 'RMB', 入账金额: '-72.11' }, 'unified'),
      historyRow({ 交易币种: 'JPY', 交易金额: '100', 入账金额: 5.12 }, 'unified'),
    ])
    const result = await preview(buffer)
    expect(result.stats.formatId).toBe('legacy-unified-bill-v1')
    expect(result.stats.validRows).toBe(4)
    expect(result.anomalies).toEqual([])
    expect(result.rows[0]!.fingerprint).toBe(result.rows[1]!.fingerprint)
    expect(result.rows[0]!.id).not.toBe(result.rows[1]!.id)
    expect(result.rows[2]).toMatchObject({ cardLast4: '0007', transactionDate: '2024-01-05', postingDate: '2024-01-06',
      transactionCurrency: 'USD', transactionAmountMinor: -1025, settlementCurrency: 'CNY', settlementAmountMinor: -7211, direction: 'credit' })
    expect(result.rows[3]!.transactionAmountMinor).toBe(100)
    await persistLegacyImport(planLegacyImport(result, EMPTY_SNAPSHOT))
    const stored = await readSnapshot()
    expect(stored.transactions).toHaveLength(4)
    expect(stored.transactions.every((row) => row.origin === 'legacy_import' && row.sourceId === 'legacy-unified-bill-v1' && row.sourceFileHash === 'unified')).toBe(true)
    expect(stored.transactions.map((row) => row.sourceRow).sort()).toEqual([2, 3, 4, 5])
    await persistLegacyImport(planLegacyImport(await preview(buffer, 'unified', stored), stored))
    expect(await db.transactions.count()).toBe(4)
  })

  it('retains future and leap-day dates unchanged with a reviewable warning', async () => {
    const result = await preview(workbookBytes('统一账单', LEGACY_UNIFIED_BILL_COLUMNS, [
      historyRow({ 交易日期: '2096-02-29', 入账日期: '2096-03-01' }, 'unified'),
    ]))
    expect(result.rows[0]!.transactionDate).toBe('2096-02-29')
    expect(result.rows[0]!.postingDate).toBe('2096-03-01')
    expect(result.reviewIssues).toHaveLength(1)
    await persistLegacyImport(planLegacyImport(result, EMPTY_SNAPSHOT))
    expect((await db.transactions.toArray())[0]).toMatchObject({ transactionDate: '2096-02-29', reviewStatus: 'pending' })
  })

  it('keeps the date of fractional Excel serials and refuses rounded numeric full-card values', async () => {
    const result = await preview(workbookBytes('统一账单', LEGACY_UNIFIED_BILL_COLUMNS, [
      historyRow({ 交易日期: 45296.75, 入账日期: 45297.9 }, 'unified'),
      historyRow({ 卡号: 1000000000000000 }, 'unified'),
    ]))
    expect(result.rows[0]).toMatchObject({ transactionDate: '2024-01-05', postingDate: '2024-01-06' })
    expect(result.stats.validRows).toBe(1)
    expect(result.anomalies[0]).toMatchObject({ rowNumber: 3, kind: 'missing_field' })
  })

  it('reports rejected rows and keeps only explicitly missing posting dates eligible for fallback', async () => {
    const result = await preview(workbookBytes('统一账单', LEGACY_UNIFIED_BILL_COLUMNS, [
      historyRow({ 入账日期: null }, 'unified'),
      historyRow({ 入账日期: '2024-02-30' }, 'unified'),
      historyRow({ 交易金额: 'bad 12.34' }, 'unified'),
      historyRow({ 交易币种: 'JPY', 交易金额: '1.5' }, 'unified'),
      historyRow({ 交易币种: 'KWD', 交易金额: '1' }, 'unified'),
      historyRow({ 银行名称: 'unrecognized' }, 'unified'),
      historyRow({ 交易金额: 'USD 5.00' }, 'unified'),
      historyRow({ 交易金额: 'SGD 5.00' }, 'unified'),
    ]))
    expect(result.stats.totalRows).toBe(8)
    expect(result.stats.validRows).toBe(1)
    expect(result.anomalies.map((row) => row.rowNumber)).toEqual([3, 4, 5, 6, 7, 8, 9])
    expect(result.rows[0]!.postingDate).toBe('2024-01-05')
    expect(result.rows[0]!.flags).toContain('date_missing')
  })

  it.each([
    ['标准字段', LEGACY_UNIFIED_COLUMNS, 'python', { transaction_currency: 'USD', transaction_amount: 'broken' }],
    ['交易明细', LEGACY_KEEPRAW_COLUMNS, 'keepraw', { 交易币种: 'USD', 交易金额: 'broken' }],
  ] as const)('never fabricates original money in %s', async (sheet, columns, format, cells) => {
    const result = await preview(workbookBytes(sheet, columns, [historyRow(cells, format)]))
    expect(result.stats.validRows).toBe(0)
    expect(result.anomalies[0]!.kind).toBe('amount_unparseable')
  })

  it('rejects a 1904 workbook before serial dates can shift silently', async () => {
    await expect(preview(workbookBytes('统一账单', LEGACY_UNIFIED_BILL_COLUMNS, [historyRow({}, 'unified')], true))).rejects.toThrow('1904')
  })

  it('refuses fractional zero-decimal amounts instead of magnifying them', () => {
    expect(parseAmountToMinor('1.5', 'JPY')).toBeNull()
    expect(parseAmountToMinor('100', 'JPY')?.minor).toBe(100)
  })
})
