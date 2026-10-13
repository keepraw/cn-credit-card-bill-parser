import * as XLSX from 'xlsx'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { readSheetData } from '../src/importers/workbook'
import { downloadXlsx, transactionToRow, EXPORT_COLUMNS, buildCsv } from '../src/export/tabular'
import { buildDemoDataset } from '../src/demo/demoData'
import { parseLegacyDate, parseLegacyAmount } from '../src/importers/legacyPythonExportV1'

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

function write(rows: unknown[][], name = '标准字段') {
  const workbook = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(rows), name)
  return XLSX.write(workbook, { bookType: 'xlsx', type: 'array' }) as ArrayBuffer
}

describe('patched XLSX compatibility', () => {
  it('keeps Chinese sheet names, raw serial dates, strings and numeric amounts', async () => {
    const buffer = write([['日期', '金额', '尾号'], [45296, 128.8, '0012'], ['2024-01-05', 0, null]])
    const result = await readSheetData(buffer, '标准字段')
    expect(result.sheetNames).toEqual(['标准字段'])
    expect(result.rows[1]).toEqual([45296, 128.8, '0012'])
    expect(parseLegacyDate(result.rows[1]![0])).toBe('2024-01-05')
    expect(parseLegacyAmount(result.rows[1]![1], 'CNY')).toBe(12880)
    expect(result.rows[2]).toEqual(['2024-01-05', 0, null])
    expect((await readSheetData(buffer, 'absent')).rows).toEqual([])
  })

  it('round-trips exported currency precision and treats formula-like text as text', async () => {
    let saved: Blob | undefined
    let filename = ''
    class DownloadURL extends URL {
      static createObjectURL(blob: Blob) { saved = blob; return 'blob:synthetic' }
      static revokeObjectURL() { /* Synthetic download has no browser resource. */ }
    }
    vi.stubGlobal('URL', DownloadURL)
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) { filename = this.download })
    const transaction = { ...buildDemoDataset()[0]!.transactions[0]!, description: '=WEBSERVICE("https://example.invalid")',
      transactionCurrency: 'JPY', transactionAmountMinor: 1200, settlementCurrency: 'USD', settlementAmountMinor: 1005 }
    await downloadXlsx('交易明细.xlsx', [transaction])
    expect(filename).toBe('交易明细.xlsx')
    const buffer = await new Promise<ArrayBuffer>((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(reader.result as ArrayBuffer)
      reader.onerror = reject
      reader.readAsArrayBuffer(saved!)
    })
    const workbook = XLSX.read(buffer, { type: 'array' })
    expect(workbook.SheetNames).toEqual(['交易明细'])
    expect(workbook.Sheets['交易明细']!.E2!.t).toBe('s')
    expect(workbook.Sheets['交易明细']!.E2!.f).toBeUndefined()
    expect((await readSheetData(buffer, '交易明细')).rows).toEqual([
      EXPORT_COLUMNS.map((column) => column.header), transactionToRow(transaction),
    ])
    expect(buildCsv([transaction])).toContain("'=WEBSERVICE")
  })
})
