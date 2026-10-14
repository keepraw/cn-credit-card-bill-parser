import { beforeEach, describe, expect, it } from 'vitest'
import { currencyExponent, isSupportedCurrency, minorToDecimalString, parseAmountToMinor } from '../src/core/money'
import { db } from '../src/db/db'
import { persistLegacyImport, readSnapshot } from '../src/db/repository'
import { planLegacyImport, previewLegacyWorkbook } from '../src/importers/legacyImport'
import { LEGACY_KEEPRAW_COLUMNS } from '../src/importers/legacyKeeprawExportV1'
import { LEGACY_UNIFIED_COLUMNS, parseLegacyAmount } from '../src/importers/legacyPythonExportV1'
import { LEGACY_UNIFIED_BILL_COLUMNS } from '../src/importers/legacyUnifiedBillV1'
import { readSheetData } from '../src/importers/workbook'
import { EMPTY_SNAPSHOT } from './fixtures/identity'
import { historyRow, workbookBytes } from './fixtures/legacyWorkbook'

const VALID_AMOUNTS = [
  [617.24, 'CNY', 61724], [324.69, 'CNY', 32469], [4.19, 'CNY', 419], [6.47, 'CNY', 647],
  [617, 'CNY', 61700], [0, 'CNY', 0], [-617.24, 'CNY', -61724],
  ['617.24', 'CNY', 61724], ['1,234.56', 'CNY', 123456], ['-617.24', 'CNY', -61724],
  [10 + 1.12, 'CNY', 1112], [11.129999999999999, 'CNY', 1113],
  [617, 'JPY', 617], ['617.00', 'JPY', 617],
] as const

const INVALID_AMOUNTS: unknown[] = [
  undefined, null, '', ' ', NaN, Infinity, -Infinity, 'NaN', 'abc',
  'amount 617.24', 'USD 617.24', 'CNY 617.24 USD', '10..25', '1,2,3.45',
  '617.241', 617.241, Number.MAX_SAFE_INTEGER,
  true, false, [617.24], { toString: () => '617.24' },
]

const HISTORICAL_CURRENCIES = ['TRY', 'MYR', 'PHP', 'IDR'] as const

describe('Excel money cell types', () => {
  it.each(VALID_AMOUNTS)('parses %s in %s as %i minor units', (value, currency, expected) => {
    expect(parseLegacyAmount(value, currency)).toBe(expected)
    expect(parseAmountToMinor(value, currency)?.minor).toBe(expected)
  })

  it('preserves the displayed decimal for both numeric and text cells', () => {
    for (const value of [617.24, '617.24']) {
      expect(minorToDecimalString(parseLegacyAmount(value, 'CNY')!, 'CNY')).toBe('617.24')
    }
  })

  it.each(INVALID_AMOUNTS)('rejects invalid or unsupported cell value %s', (value) => {
    expect(parseLegacyAmount(value, 'CNY')).toBeNull()
    expect(parseAmountToMinor(value, 'CNY')).toBeNull()
  })

  it('keeps currency precision and safe integer checks for numeric cells', () => {
    expect(parseLegacyAmount(617.24, 'JPY')).toBeNull()
    expect(parseLegacyAmount(617, 'KWD')).toBeNull()
    expect(parseAmountToMinor(617.24, 'JPY')).toBeNull()
    expect(() => parseAmountToMinor(617, 'KWD')).toThrow('货币精度')
  })

  it.each(HISTORICAL_CURRENCIES)('%s has explicit two-decimal precision for numeric and text cells', (currency) => {
    expect(isSupportedCurrency(currency)).toBe(true)
    expect(currencyExponent(currency)).toBe(2)
    for (const value of [246.81, '246.81', `${currency} 246.81`]) {
      expect(parseLegacyAmount(value, currency)).toBe(24681)
      expect(parseAmountToMinor(value, currency)?.minor).toBe(24681)
    }
    expect(parseLegacyAmount(246, currency)).toBe(24600)
    expect(parseLegacyAmount(0, currency)).toBe(0)
    expect(parseLegacyAmount(-246.81, currency)).toBe(-24681)
    expect(parseLegacyAmount('1,234.56', currency)).toBe(123456)
    expect(parseLegacyAmount(246.811, currency)).toBeNull()
    expect(parseLegacyAmount('246.811', currency)).toBeNull()
    expect(parseLegacyAmount('CNY 246.81', currency)).toBeNull()
    expect(parseLegacyAmount(`${currency} 246.81`, 'CNY')).toBeNull()
    expect(parseAmountToMinor(246.811, currency)).toBeNull()
    expect(parseAmountToMinor('246.811', currency)).toBeNull()
    expect(parseAmountToMinor('CNY 246.81', currency)).toBeNull()
  })
})

const FORMATS = [
  ['标准字段', LEGACY_UNIFIED_COLUMNS, 'python', 'transaction_amount', 'settlement_amount'],
  ['交易明细', LEGACY_KEEPRAW_COLUMNS, 'keepraw', '交易金额', '结算金额'],
  ['统一账单', LEGACY_UNIFIED_BILL_COLUMNS, 'unified', '交易金额', '入账金额'],
] as const

const MONEY_ROWS = [
  [617.24, 324.69, 61724, 32469],
  [4.19, 6.47, 419, 647],
  ['617.24', '324.69', 61724, 32469],
  [617, 324, 61700, 32400],
  [-617.24, -324.69, -61724, -32469],
  [0, 0, 0, 0],
  [10 + 1.12, 11.129999999999999, 1112, 1113],
] as const

beforeEach(async () => { await db.delete(); await db.open() })

for (const [sheet, headers, format, transactionColumn, settlementColumn] of FORMATS) {
  describe(`${sheet}: XLSX money validation and persistence`, () => {
    const workbook = (rows: unknown[][]) => workbookBytes(sheet, headers, rows)
    const preview = (buffer: ArrayBuffer) => previewLegacyWorkbook(buffer,
      { fileName: 'synthetic-money.xlsx', fileHash: `synthetic-money-${format}`, fileSize: buffer.byteLength }, EMPTY_SNAPSHOT)

    it.each(HISTORICAL_CURRENCIES)('%s preserves the original and settlement legs through XLSX and storage', async (currency) => {
      const transactionCurrencyColumn = format === 'python' ? 'transaction_currency' : '交易币种'
      const settlementCurrencyColumn = format === 'python' ? 'settlement_currency' : format === 'unified' ? '入账币种' : '结算币种'
      const buffer = workbook([
        historyRow({ [transactionCurrencyColumn]: currency, [transactionColumn]: 246.81,
          [settlementCurrencyColumn]: 'CNY', [settlementColumn]: '135.79' }, format),
        historyRow({ [transactionCurrencyColumn]: 'CNY', [transactionColumn]: '-135.79',
          [settlementCurrencyColumn]: currency, [settlementColumn]: -246.81 }, format),
      ])
      const result = await preview(buffer)
      expect(result.stats).toMatchObject({ totalRows: 2, validRows: 2, anomalyRows: 0 })
      expect(result.anomalies).toEqual([])
      const expected = [
        { sourceRow: 2, transactionCurrency: currency, transactionAmountMinor: 24681,
          settlementCurrency: 'CNY', settlementAmountMinor: 13579 },
        { sourceRow: 3, transactionCurrency: 'CNY', transactionAmountMinor: -13579,
          settlementCurrency: currency, settlementAmountMinor: -24681 },
      ]
      expect(result.rows).toMatchObject(expected)
      const plan = planLegacyImport(result, EMPTY_SNAPSHOT)
      expect(plan.skipped).toBe(0)
      await persistLegacyImport(plan)
      expect((await readSnapshot()).transactions.sort((a, b) => a.sourceRow! - b.sourceRow!)).toMatchObject(expected)
    })

    it('imports every numeric/text row and repeated occurrence with both original monetary legs', async () => {
      const cases = [...MONEY_ROWS, MONEY_ROWS[0]]
      const buffer = workbook(cases.map(([transaction, settlement]) =>
        historyRow({ [transactionColumn]: transaction, [settlementColumn]: settlement }, format)))
      const raw = await readSheetData(buffer, sheet)
      const transactionIndex = headers.findIndex((header) => header === transactionColumn)
      expect(raw.rows[1]![transactionIndex]).toBe(617.24)
      expect(raw.rows[3]![transactionIndex]).toBe('617.24')
      const result = await preview(buffer)
      expect(result.stats).toMatchObject({ totalRows: cases.length, validRows: cases.length, anomalyRows: 0 })
      expect(result.anomalies).toEqual([])
      const expected = cases.map(([, , transactionAmountMinor, settlementAmountMinor], index) =>
        ({ sourceRow: index + 2, transactionAmountMinor, settlementAmountMinor }))
      expect(result.rows.map(({ sourceRow, transactionAmountMinor, settlementAmountMinor }) =>
        ({ sourceRow, transactionAmountMinor, settlementAmountMinor }))).toEqual(expected)
      const plan = planLegacyImport(result, EMPTY_SNAPSHOT)
      expect(plan.inserted).toHaveLength(cases.length)
      expect(plan.skipped).toBe(0)
      await persistLegacyImport(plan)
      const stored = (await readSnapshot()).transactions.sort((a, b) => a.sourceRow! - b.sourceRow!)
      expect(stored.map(({ sourceRow, transactionAmountMinor, settlementAmountMinor }) =>
        ({ sourceRow, transactionAmountMinor, settlementAmountMinor }))).toEqual(expected)
      expect(new Set(stored.map((row) => row.id)).size).toBe(cases.length)
    })

    for (const column of [transactionColumn, settlementColumn]) {
      it.each([undefined, null, '', ' ', 'abc', 'USD 617.24', 617.241])(
        `${column}: reports an explicit source-row error for %s without borrowing the other leg`, async (value) => {
          const result = await preview(workbook([
            historyRow({}, format), historyRow({ [column]: value }, format), historyRow({}, format),
          ]))
          expect(result.stats).toMatchObject({ totalRows: 3, validRows: 2, anomalyRows: 1 })
          expect(result.rows.map((row) => row.sourceRow)).toEqual([2, 4])
          expect(result.anomalies).toEqual([expect.objectContaining({ rowNumber: 3, kind: 'amount_unparseable' })])
          const expectedDetail = format === 'unified' ? /交易金额或入账金额/ :
            column === transactionColumn ? /交易金额无法解析，不以结算金额替代/ : /结算金额无法解析/
          expect(result.anomalies[0]!.detail).toMatch(expectedDetail)
          const plan = planLegacyImport(result, EMPTY_SNAPSHOT)
          expect(plan.anomalies).toEqual(result.anomalies)
          await persistLegacyImport(plan)
          expect((await readSnapshot()).transactions.map((row) => row.sourceRow).sort()).toEqual([2, 4])
        })
    }
  })
}
