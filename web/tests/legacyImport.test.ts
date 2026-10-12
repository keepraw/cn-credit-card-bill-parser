import * as XLSX from 'xlsx'
import { beforeEach, describe, expect, it } from 'vitest'
import { db } from '../src/db/db'
import { readSnapshot } from '../src/db/repository'
import { transactionFingerprint } from '../src/core/identity'
import { transactionId } from '../src/core/dedupe'
import {
  LEGACY_UNIFIED_COLUMNS,
  detectLegacyShape,
  parseLegacyAmount,
  parseLegacyDate,
} from '../src/importers/legacyPythonExportV1'
import {
  LEGACY_ADAPTER_VERSION,
  LegacyFormatError,
  planLegacyImport,
  previewLegacyWorkbook,
} from '../src/importers/legacyImport'
import { LEGACY_PYTHON_EXPORT_V1 } from '../src/importers/types'
import { persistLegacyImport } from '../src/db/repository'

const HEADERS = [...LEGACY_UNIFIED_COLUMNS]

function serialOf(y: number, m: number, d: number): number {
  return Math.round((Date.UTC(y, m - 1, d) - Date.UTC(1899, 11, 30)) / 86_400_000)
}

interface RowOverrides {
  bank?: unknown
  card_last4?: unknown
  statement_start?: unknown
  statement_end?: unknown
  transaction_date?: unknown
  posting_date?: unknown
  description?: unknown
  transaction_currency?: unknown
  transaction_amount?: unknown
  settlement_currency?: unknown
  settlement_amount?: unknown
  confidence?: unknown
  raw_text?: unknown
}

function legacyRow(overrides: RowOverrides = {}): unknown[] {
  const base: Record<string, unknown> = {
    bank: '中国银行',
    card_last4: '1234',
    statement_start: '2024-01-01',
    statement_end: '2024-01-31',
    transaction_date: '2024-01-05',
    posting_date: '2024-01-06',
    description: '消费 示例商户',
    transaction_currency: 'CNY',
    transaction_amount: 128.8,
    settlement_currency: 'CNY',
    settlement_amount: 128.8,
    source_file_name: 'old.pdf',
    source_file_hash: 'oldhash',
    confidence: 0.95,
    raw_text: '2024-01-05 | 1234 | 消费 示例商户',
    ...overrides,
  }
  return HEADERS.map((header) => base[header] ?? null)
}

function workbookBuffer(headers: string[], rows: unknown[][], sheetName = '标准字段'): ArrayBuffer {
  const ws = XLSX.utils.aoa_to_sheet([headers, ...rows])
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, sheetName)
  const out = XLSX.write(wb, { bookType: 'xlsx', type: 'array' }) as unknown
  return new Uint8Array(out as ArrayLike<number>).buffer as ArrayBuffer
}

const EMPTY = { imports: [], statements: [], transactions: [] }

async function previewOf(buffer: ArrayBuffer, fileHash = 'test-hash') {
  return previewLegacyWorkbook(buffer, { fileName: 'history.xlsx', fileSize: buffer.byteLength, fileHash }, EMPTY)
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

describe('legacy adapter detection', () => {
  it('recognises the 标准字段 sheet of a legacy python export', async () => {
    const buffer = workbookBuffer(HEADERS, [legacyRow()])
    const preview = await previewOf(buffer)
    expect(preview.stats.formatId).toBe(LEGACY_PYTHON_EXPORT_V1)
    expect(preview.stats.totalRows).toBe(1)
    expect(preview.stats.validRows).toBe(1)
  })

  it('reads the header shape strictly', () => {
    expect(detectLegacyShape(HEADERS)).not.toBeNull()
    expect(detectLegacyShape(['bank', 'description'])).toBeNull()
  })

  it('rejects a friendly-only workbook without the standard sheet', async () => {
    const buffer = workbookBuffer(['银行', '卡尾号', '交易日'], [['中国银行', '1234', '2024-01-05']], '交易明细')
    await expect(previewOf(buffer)).rejects.toThrow(LegacyFormatError)
  })

  it('rejects a review workbook carrying different 标准字段 columns', async () => {
    const buffer = workbookBuffer(
      ['reason', 'source_file_name', 'bank', 'detail'],
      [['too_many_pages', 'a.pdf', '中国银行', 'x']],
    )
    await expect(previewOf(buffer)).rejects.toThrow(/无法识别该历史数据格式/)
  })
})

describe('unsupported excel', () => {
  it('rejects unknown sheets and headers instead of guessing', async () => {
    const buffer = workbookBuffer(['姓名', '金额', '备注'], [['张三', 100, '午餐']], 'Sheet1')
    await expect(previewOf(buffer)).rejects.toThrow(/无法识别该历史数据格式/)
  })

  it('rejects a missing required column', async () => {
    const headers = HEADERS.filter((header) => header !== 'settlement_amount')
    const buffer = workbookBuffer(
      headers,
      [legacyRow()].map((row) => row.filter((_, index) => HEADERS[index] !== 'settlement_amount')),
    )
    await expect(previewOf(buffer)).rejects.toThrow(/无法识别该历史数据格式/)
  })
})

describe('legacy preview', () => {
  it('reports counts, date range, banks and anomalies without writing', async () => {
    const rows = [
      legacyRow({ description: '消费 商户A', transaction_date: '2024-01-05', settlement_amount: 100 }),
      legacyRow({ description: '消费 商户B', transaction_date: serialOf(2024, 2, 10), settlement_amount: 200.5 }),
      legacyRow({
        bank: '交通银行',
        description: '还款 转账还款',
        transaction_date: '2024-03-10',
        settlement_amount: -500,
      }),
      legacyRow({ bank: '交通银行', description: '消费 商户C', transaction_date: '2024-02-01', settlement_amount: 88.88 }),
      legacyRow({ description: '消费 商户D', transaction_date: '2024-01-20', settlement_amount: 10 }),
      legacyRow({ description: '   ' }),
      legacyRow({ description: '消费 坏日期', transaction_date: '不是日期', posting_date: '也不是日期' }),
      legacyRow({ description: '消费 坏金额', settlement_amount: 'N/A' }),
    ]
    const buffer = workbookBuffer(HEADERS, rows)
    const before = await db.transactions.count()
    const preview = await previewOf(buffer)

    expect(preview.stats.totalRows).toBe(8)
    expect(preview.stats.validRows).toBe(5)
    expect(preview.stats.anomalyRows).toBe(3)
    expect(preview.stats.anomaliesByKind).toEqual({ missing_field: 1, date_unparseable: 1, amount_unparseable: 1 })
    expect(preview.stats.dateRange).toEqual({ min: '2024-01-05', max: '2024-03-10' })
    expect(preview.stats.banks).toEqual(['boc', 'bocom'])
    expect(preview.anomalies).toHaveLength(3)
    // Preview is read-only.
    expect(await db.transactions.count()).toBe(before)
  })
})

describe('legacy import mapping', () => {
  it('marks provenance, keeps raw text and never reconciles', async () => {
    const buffer = workbookBuffer(
      HEADERS,
      [legacyRow(), legacyRow({ description: '还款 转账还款', settlement_amount: -300, transaction_amount: -300 })],
    )
    const preview = await previewOf(buffer)
    const plan = planLegacyImport(preview, EMPTY)

    expect(plan.record.status).toBe('imported')
    expect(plan.record.sourceType).toBe('xlsx')
    expect(plan.record.parserId).toBe(LEGACY_PYTHON_EXPORT_V1)
    expect(plan.record.statementId).toBeNull()
    expect(plan.inserted).toHaveLength(2)

    const first = plan.inserted[0]!
    expect(first.origin).toBe('legacy_import')
    expect(first.sourceId).toBe(LEGACY_PYTHON_EXPORT_V1)
    expect(first.sourceFileName).toBe('history.xlsx')
    expect(first.sourceFileHash).toBe('test-hash')
    expect(first.rawDescription).toBe('消费 示例商户')
    expect(first.rawText).toContain('2024-01-05')
    expect(first.transactionAmountMinor).toBe(12880)
    expect(first.settlementAmountMinor).toBe(12880)
    expect(first.direction).toBe('debit')
    expect(first.type).toBe('purchase')
    expect(first.isDemo).toBe(false)

    const payment = plan.inserted[1]!
    expect(payment.direction).toBe('credit')
    expect(payment.settlementAmountMinor).toBe(-30000)
    expect(payment.type).toBe('payment')

    for (const statement of plan.statements) {
      expect(statement.status).toBe('imported')
      expect(statement.parserId).toBe(LEGACY_PYTHON_EXPORT_V1)
      expect(statement.reconciliation.status).toBe('insufficient')
    }
    expect(LEGACY_ADAPTER_VERSION).toBe('1.0.0')
  })

  it('uses the shared fingerprint scheme for identity', async () => {
    const buffer = workbookBuffer(HEADERS, [legacyRow()])
    const preview = await previewOf(buffer)
    const row = preview.rows[0]!
    const expected = transactionFingerprint({
      bank: 'boc',
      cardLast4: '1234',
      transactionDate: '2024-01-05',
      postingDate: '2024-01-06',
      settlementCurrency: 'CNY',
      settlementAmountMinor: 12880,
      type: 'purchase',
      description: '消费 示例商户',
    })
    expect(row.fingerprint).toBe(expected)
    expect(row.id).toBe(transactionId(expected, 1))
  })

  it('parses excel serials, iso strings and amounts without float drift', () => {
    expect(parseLegacyDate(serialOf(2024, 1, 5))).toBe('2024-01-05')
    expect(parseLegacyDate('20240105')).toBe('2024-01-05')
    expect(parseLegacyDate('not a date')).toBeNull()
    expect(parseLegacyAmount(128.8, 'CNY')).toBe(12880)
    expect(parseLegacyAmount('1,234.56', 'CNY')).toBe(123456)
    expect(parseLegacyAmount('-500', 'CNY')).toBe(-50000)
    expect(parseLegacyAmount('N/A', 'CNY')).toBeNull()
    // Binary float dust from real exports snaps to the fen …
    expect(parseLegacyAmount(10 + 112 / 100, 'CNY')).toBe(1112)
    expect(parseLegacyAmount(11.129999999999999, 'CNY')).toBe(1113)
    // … while genuine extra precision is still refused, not rounded.
    expect(parseLegacyAmount(10.005, 'CNY')).toBeNull()
    expect(parseLegacyAmount('10.005', 'CNY')).toBeNull()
  })
})

describe('duplicate legacy import', () => {
  it('re-importing the same file adds nothing', async () => {
    const buffer = workbookBuffer(HEADERS, [legacyRow(), legacyRow({ description: '消费 第二笔', settlement_amount: 50 })])
    const preview = await previewOf(buffer, 'same-file-hash')
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
    expect(await db.imports.count()).toBe(1)
  })
})

describe('legacy import performance', () => {
  it('handles 18000+ rows with batched writes', async () => {
    const rows: unknown[][] = []
    for (let i = 0; i < 18_500; i++) {
      const day = (i % 28) + 1
      rows.push(
        legacyRow({
          description: `消费 性能商户${i % 500}`,
          transaction_date: `2023-${String((i % 12) + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
          posting_date: `2023-${String((i % 12) + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
          settlement_amount: 10 + (i % 9000) / 100,
          transaction_amount: 10 + (i % 9000) / 100,
          bank: i % 3 === 0 ? '交通银行' : '中国银行',
          card_last4: i % 2 === 0 ? '1234' : '5678',
        }),
      )
    }
    const buffer = workbookBuffer(HEADERS, rows)
    const started = performance.now()
    const preview = await previewOf(buffer, 'perf-hash')
    const previewMs = performance.now() - started
    expect(preview.stats.validRows).toBe(18_500)

    const planned = performance.now()
    const plan = planLegacyImport(preview, EMPTY)
    expect(plan.inserted).toHaveLength(18_500)
    const planMs = performance.now() - planned

    await persistLegacyImport(plan)
    const writeMs = performance.now() - planned - planMs
    const totalMs = performance.now() - started
    // eslint-disable-next-line no-console
    console.info(
      `legacy-import perf: rows=18500 preview=${previewMs.toFixed(0)}ms plan=${planMs.toFixed(0)}ms write=${writeMs.toFixed(0)}ms total=${totalMs.toFixed(0)}ms`,
    )
    expect(await db.transactions.count()).toBe(18_500)
  }, 120_000)
})
