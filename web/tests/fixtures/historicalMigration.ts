import type { BankId, Direction, TransactionType } from '../../src/core/types'
import { LEGACY_KEEPRAW_COLUMNS } from '../../src/importers/legacyKeeprawExportV1'
import { LEGACY_UNIFIED_COLUMNS } from '../../src/importers/legacyPythonExportV1'
import { LEGACY_UNIFIED_BILL_COLUMNS } from '../../src/importers/legacyUnifiedBillV1'
import { historyRow, workbookBytes } from './legacyWorkbook'

/** Invented reference data only. No historical statement or Python output is read. */
export const MIGRATION_FORMATS = [
  { sheet: '标准字段', columns: LEGACY_UNIFIED_COLUMNS, format: 'python' },
  { sheet: '交易明细', columns: LEGACY_KEEPRAW_COLUMNS, format: 'keepraw' },
  { sheet: '统一账单', columns: LEGACY_UNIFIED_BILL_COLUMNS, format: 'unified' },
] as const

const BANK_CASES: Array<[BankId, string, string]> = [
  ['boc', '中国银行', '0001'], ['icbc', '工商银行', '0002'], ['abc', '农业银行', '0003'],
  ['ccb', '建设银行', '0004'], ['bocom', '交通银行', '0005'], ['citic', '中信银行', '0006'],
]

// Expected minor units, signs and types are literal independent references.
const AMOUNTS: Array<[string, TransactionType, Direction, string, number | string, number, string, number | string, number]> = [
  ['消费 合成商户', 'purchase', 'debit', 'CNY', 125.35, 12535, 'CNY', '125.35', 12535],
  ['消费 合成商户', 'purchase', 'debit', 'CNY', 125.35, 12535, 'CNY', '125.35', 12535],
  ['退款 合成商户', 'refund', 'credit', 'JPY', -800, -800, 'CNY', '-38.65', -3865],
  ['还款 合成转账', 'payment', 'credit', 'USD', '-21.43', -2143, 'CNY', -156.72, -15672],
  ['返现 合成活动', 'cashback', 'credit', 'CNY', -1.06, -106, 'CNY', -1.06, -106],
  ['手续费 合成服务', 'fee', 'debit', 'HKD', '12.25', 1225, 'CNY', 11.17, 1117],
  ['利息 合成计息', 'interest', 'debit', 'CNY', 2.18, 218, 'CNY', 2.18, 218],
  ['分期原始 合成购物', 'installment_original', 'debit', 'CNY', 888.88, 88888, 'CNY', 888.88, 88888],
  ['分期扣款 合成购物', 'installment_payment', 'debit', 'MYR', 100.25, 10025, 'CNY', 152.75, 15275],
  ['调整 合成入账', 'adjustment', 'credit', 'USD', '-3.31', -331, 'USD', -3.31, -331],
  ['取现 合成取现', 'cash_advance', 'debit', 'TRY', 305.12, 30512, 'CNY', 68.43, 6843],
  ['消费 合成商户另一笔', 'purchase', 'debit', 'CNY', 125.35, 12535, 'CNY', '125.35', 12535],
]

export function migrationFixture(format: typeof MIGRATION_FORMATS[number]) {
  const expected = BANK_CASES.flatMap(([bank, bankName, cardLast4]) => AMOUNTS.map((
    [text, type, direction, transactionCurrency, transactionAmount, transactionAmountMinor, settlementCurrency, settlementAmount, settlementAmountMinor],
  ) => ({ bank, bankName, cardLast4, description: `${text} ${bank.toUpperCase()}`, type, direction,
    transactionCurrency, transactionAmount, transactionAmountMinor, settlementCurrency, settlementAmount, settlementAmountMinor,
    transactionDate: '2024-01-05', postingDate: '2024-01-06' })))
  const rows = expected.map((row) => historyRow({
    bank: row.bankName, card_last4: row.cardLast4, transaction_amount: row.transactionAmount,
    settlement_amount: row.settlementAmount, transaction_currency: row.transactionCurrency,
    settlement_currency: row.settlementCurrency, description: row.description,
    银行: row.bankName, 卡尾号: row.cardLast4, 说明: row.description,
    银行名称: row.bankName, 卡号: `****${row.cardLast4}`, 交易详情: row.description,
    交易日期: 45296, 入账日期: 45297, 交易币种: row.transactionCurrency, 交易金额: row.transactionAmount,
    结算币种: row.settlementCurrency, 结算金额: row.settlementAmount,
    入账币种: row.settlementCurrency, 入账金额: row.settlementAmount,
  }, format.format))
  return { buffer: workbookBytes(format.sheet, format.columns, rows), expected }
}
