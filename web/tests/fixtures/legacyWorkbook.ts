import * as XLSX from 'xlsx'
import { LEGACY_UNIFIED_COLUMNS } from '../../src/importers/legacyPythonExportV1'
import { LEGACY_KEEPRAW_COLUMNS } from '../../src/importers/legacyKeeprawExportV1'
import { LEGACY_UNIFIED_BILL_COLUMNS } from '../../src/importers/legacyUnifiedBillV1'

export function workbookBytes(sheet: string, headers: readonly string[], rows: unknown[][], date1904 = false): ArrayBuffer {
  const workbook = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([[...headers], ...rows]), sheet)
  if (date1904) workbook.Workbook = { WBProps: { date1904: true } }
  return XLSX.write(workbook, { bookType: 'xlsx', type: 'array' }) as ArrayBuffer
}

export function historyRow(overrides: Record<string, unknown> = {}, format = 'python'): unknown[] {
  const columns = format === 'unified' ? LEGACY_UNIFIED_BILL_COLUMNS : format === 'keepraw' ? LEGACY_KEEPRAW_COLUMNS : LEGACY_UNIFIED_COLUMNS
  const row = {
    bank: '中国银行', card_last4: '1234', statement_start: '2024-01-01', statement_end: '2024-01-31',
    transaction_date: '2024-01-05', posting_date: '2024-01-06', description: '消费 合成商户',
    transaction_currency: 'CNY', transaction_amount: 128.8, settlement_currency: 'CNY', settlement_amount: 128.8,
    source_file_name: 'synthetic.txt', source_file_hash: 'synthetic-source', confidence: 1, raw_text: 'synthetic row',
    银行名称: '中国银行', 卡号: '1234', 交易日期: '2024-01-05', 入账日期: '2024-01-06', 交易详情: '消费 合成商户',
    银行: '中国银行', 卡尾号: '1234', 交易日: '2024-01-05', 入账日: '2024-01-06', 说明: '消费 合成商户',
    交易币种: 'CNY', 交易金额: 128.8, 入账币种: 'CNY', 入账金额: 128.8, 结算币种: 'CNY', 结算金额: 128.8,
    ...overrides,
  } as Record<string, unknown>
  return columns.map((column) => row[column])
}
