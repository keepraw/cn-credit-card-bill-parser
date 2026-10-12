import * as XLSX from 'xlsx'
import { beforeEach, describe, expect, it } from 'vitest'
import { db } from '../src/db/db'
import { transactionFingerprint } from '../src/core/identity'
import { detectKeeprawShape, LEGACY_KEEPRAW_COLUMNS, LEGACY_KEEPRAW_SHEET } from '../src/importers/legacyKeeprawExportV1'
import { LegacyFormatError, planLegacyImport, previewLegacyWorkbook } from '../src/importers/legacyImport'
import { LEGACY_KEEPRAW_EXPORT_V1 } from '../src/importers/types'
import { persistLegacyImport } from '../src/db/repository'
import { readSnapshot } from '../src/db/repository'

const HEADERS = [...LEGACY_KEEPRAW_COLUMNS]

interface KeeprawOverrides {
  银行?: unknown
  卡尾号?: unknown
  交易日?: unknown
  入账日?: unknown
  说明?: unknown
  交易币种?: unknown
  交易金额?: unknown
  结算币种?: unknown
  结算金额?: unknown
}

function keeprawRow(overrides: KeeprawOverrides = {}): unknown[] {
  const base: Record<string, unknown> = {
    银行: '中国银行',
    卡尾号: '1234',
    交易日: '2026-01-05',
    入账日: '2026-01-06',
    说明: '消费 示例商户',
    交易币种: 'CNY',
    交易金额: 128.8,
    结算币种: 'CNY',
    结算金额: 128.8,
    ...overrides,
  }
  return HEADERS.map((header) => base[header] ?? null)
}

function workbookBuffer(headers: string[], rows: unknown[][], sheetName = LEGACY_KEEPRAW_SHEET): ArrayBuffer {
  const ws = XLSX.utils.aoa_to_sheet([headers, ...rows])
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, sheetName)
  const out = XLSX.write(wb, { bookType: 'xlsx', type: 'array' }) as unknown
  return new Uint8Array(out as ArrayLike<number>).buffer as ArrayBuffer
}

const EMPTY = { imports: [], statements: [], transactions: [] }

async function previewOf(buffer: ArrayBuffer, fileHash = 'keepraw-test-hash', fileName = '2026信用卡账单.xlsx') {
  return previewLegacyWorkbook(buffer, { fileName, fileSize: buffer.byteLength, fileHash }, EMPTY)
}

async function clearDb(): Promise<void> {
  await db.transaction('rw', [db.statements, db.transactions, db.imports, db.settings, db.reviewNotes], async () => {
    await db.statements.clear()
    await db.transactions.clear()
    await db.imports.clear()
    await db.settings.clear()
    await db.reviewNotes.clear()
  })
}

beforeEach(async () => {
  await clearDb()
})

describe('keepraw adapter detect', () => {
  it('recognises the 交易明细 sheet with the nine fixed columns', () => {
    expect(detectKeeprawShape(HEADERS)).not.toBeNull()
  })

  it('rejects a file missing any fixed column instead of guessing', () => {
    for (const missing of HEADERS) {
      const headers = HEADERS.filter((h) => h !== missing)
      expect(detectKeeprawShape(headers)).toBeNull()
    }
  })

  it('rejects an unknown workbook', async () => {
    const buffer = workbookBuffer(['姓名', '金额', '备注'], [['张三', 100, '午餐']], 'Sheet1')
    await expect(previewOf(buffer)).rejects.toThrow(LegacyFormatError)
  })
})

describe('keepraw preview', () => {
  it('previews the real 2026 format with correct mapping', async () => {
    const buffer = workbookBuffer(HEADERS, [
      keeprawRow(),
      keeprawRow({ 说明: '还款 转账还款', 交易金额: -300, 结算金额: -300 }),
      keeprawRow({ 银行: '交通银行', 说明: '消费 商户B', 交易日: '2026-02-10', 结算金额: 200.5, 交易金额: 200.5 }),
    ])
    const preview = await previewOf(buffer)

    expect(preview.stats.formatId).toBe(LEGACY_KEEPRAW_EXPORT_V1)
    expect(preview.stats.totalRows).toBe(3)
    expect(preview.stats.validRows).toBe(3)
    expect(preview.stats.anomalyRows).toBe(0)
    expect(preview.stats.banks).toEqual(['boc', 'bocom'])
    expect(preview.stats.dateRange).toEqual({ min: '2026-01-05', max: '2026-02-10' })

    const first = preview.rows[0]!
    expect(first.bank).toBe('boc')
    expect(first.cardLast4).toBe('1234')
    expect(first.transactionDate).toBe('2026-01-05')
    expect(first.postingDate).toBe('2026-01-06')
    expect(first.description).toBe('消费 示例商户')
    expect(first.rawDescription).toBe('消费 示例商户')
    expect(first.rawText).toBe('消费 示例商户')
    expect(first.transactionCurrency).toBe('CNY')
    expect(first.transactionAmountMinor).toBe(12880)
    expect(first.settlementCurrency).toBe('CNY')
    expect(first.settlementAmountMinor).toBe(12880)
    expect(first.direction).toBe('debit')
    expect(first.type).toBe('purchase')

    const payment = preview.rows[1]!
    expect(payment.direction).toBe('credit')
    expect(payment.settlementAmountMinor).toBe(-30000)
    expect(payment.type).toBe('payment')
  })

  it('excludes anomalous rows without importing them', async () => {
    const buffer = workbookBuffer(HEADERS, [
      keeprawRow(),
      keeprawRow({ 说明: '   ' }),
      keeprawRow({ 说明: '消费 坏日期', 交易日: '不是日期', 入账日: '也不是日期' }),
      keeprawRow({ 说明: '消费 坏金额', 结算金额: 'N/A' }),
    ])
    const preview = await previewOf(buffer)
    expect(preview.stats.totalRows).toBe(4)
    expect(preview.stats.validRows).toBe(1)
    expect(preview.stats.anomalyRows).toBe(3)
    expect(preview.stats.anomaliesByKind).toEqual({ missing_field: 1, date_unparseable: 1, amount_unparseable: 1 })
  })
})

describe('keepraw import', () => {
  it('imports with legacy_import provenance and keepraw sourceId', async () => {
    const buffer = workbookBuffer(HEADERS, [
      keeprawRow(),
      keeprawRow({ 说明: '还款 转账还款', 交易金额: -300, 结算金额: -300 }),
    ])
    const preview = await previewOf(buffer)
    const plan = planLegacyImport(preview, EMPTY)

    expect(plan.record.status).toBe('imported')
    expect(plan.record.sourceType).toBe('xlsx')
    expect(plan.record.parserId).toBe(LEGACY_KEEPRAW_EXPORT_V1)
    expect(plan.inserted).toHaveLength(2)

    const first = plan.inserted[0]!
    expect(first.origin).toBe('legacy_import')
    expect(first.sourceId).toBe(LEGACY_KEEPRAW_EXPORT_V1)
    expect(first.sourceFileName).toBe('2026信用卡账单.xlsx')
    expect(first.isDemo).toBe(false)

    for (const statement of plan.statements) {
      expect(statement.status).toBe('imported')
      expect(statement.parserId).toBe(LEGACY_KEEPRAW_EXPORT_V1)
      expect(statement.reconciliation.status).toBe('insufficient')
    }
  })

  it('uses the shared fingerprint scheme (no fingerprint change)', async () => {
    const buffer = workbookBuffer(HEADERS, [keeprawRow()])
    const preview = await previewOf(buffer)
    const row = preview.rows[0]!
    const expected = transactionFingerprint({
      bank: 'boc',
      cardLast4: '1234',
      transactionDate: '2026-01-05',
      postingDate: '2026-01-06',
      settlementCurrency: 'CNY',
      settlementAmountMinor: 12880,
      type: 'purchase',
      description: '消费 示例商户',
    })
    expect(row.fingerprint).toBe(expected)
  })

  it('dedupes a repeated import (same file adds nothing)', async () => {
    const buffer = workbookBuffer(HEADERS, [
      keeprawRow(),
      keeprawRow({ 说明: '消费 第二笔', 结算金额: 50, 交易金额: 50 }),
    ])
    const preview = await previewOf(buffer, 'same-keepraw-hash')
    await persistLegacyImport(planLegacyImport(preview, EMPTY))
    expect(await db.transactions.count()).toBe(2)
    expect(await db.imports.count()).toBe(1)

    const snapshot = await readSnapshot()
    const second = planLegacyImport(preview, snapshot)
    expect(second.inserted).toHaveLength(0)
    expect(second.skipped).toBe(2)
    expect(second.record.status).toBe('duplicate')
    await persistLegacyImport(second)
    expect(await db.transactions.count()).toBe(2)
  })
})
