import { describe, expect, it } from 'vitest'
import { ccbParser, locateCycle, locateTxnTable, parseCombinedAmount } from '../src/parsers/ccb'
import { extractTables, extractText, sanitizeHtml } from '../src/parsers/html'
import type { SourceDocument } from '../src/parsers/types'
import { SYNTHETIC_CCB, SYNTHETIC_CCB_HTML } from './fixtures/ccbEml'
import { ingestParsedStatement, type ExistingSnapshot } from '../src/core/ingest'

function makeDoc(html = SYNTHETIC_CCB_HTML): SourceDocument {
  const safe = sanitizeHtml(html)
  return {
    fileName: 'synthetic-ccb.eml',
    fileSize: 5000,
    fileHash: 'hash-ccb',
    sourceType: 'eml',
    pdf: null,
    html: safe,
    tables: extractTables(safe),
    text: extractText(safe),
    email: { subject: '中国建设银行信用卡电子账单', from: 'service@vip.ccb.com', date: '2026-08-15' },
  }
}

const EMPTY: ExistingSnapshot = { statements: [], transactions: [], imports: [] }

describe('CCB EML parser', () => {
  it('recognises the bank and product', () => {
    expect(ccbParser.match(makeDoc())).toBe(1)
  })

  it('extracts card last four and the statement cycle', () => {
    const statement = ccbParser.parse(makeDoc())
    expect(statement.cardLast4).toBe(SYNTHETIC_CCB.cardLast4)
    expect(statement.cycleStart).toBe(SYNTHETIC_CCB.cycleStart)
    expect(statement.cycleEnd).toBe(SYNTHETIC_CCB.cycleEnd)
    expect(statement.dueDate).toBe(SYNTHETIC_CCB.dueDate)
  })

  it('finds the transaction table', () => {
    expect(locateTxnTable(makeDoc())).not.toBeNull()
  })

  it('extracts the cycle from the header', () => {
    expect(locateCycle(makeDoc())).toEqual({ start: SYNTHETIC_CCB.cycleStart, end: SYNTHETIC_CCB.cycleEnd })
  })

  it('reads every transaction row', () => {
    const statement = ccbParser.parse(makeDoc())
    expect(statement.transactions).toHaveLength(
      SYNTHETIC_CCB.creditTransactionCount + SYNTHETIC_CCB.debitTransactionCount,
    )
  })

  it('extracts summary components', () => {
    const { summary } = ccbParser.parse(makeDoc())
    expect(summary.previousBalanceMinor).toBe(SYNTHETIC_CCB.previousBalanceMinor)
    expect(summary.newCreditMinor).toBe(SYNTHETIC_CCB.newCreditMinor)
    expect(summary.newDebitMinor).toBe(SYNTHETIC_CCB.newDebitMinor)
    expect(summary.currentBalanceMinor).toBe(SYNTHETIC_CCB.currentBalanceMinor)
  })

  it('balances the statement equation', () => {
    const { summary } = ccbParser.parse(makeDoc())
    const computed =
      summary.previousBalanceMinor! + summary.newDebitMinor! - summary.newCreditMinor!
    expect(computed).toBe(summary.currentBalanceMinor)
  })

  it('uses the signed amount, not the merchant text, for the direction', () => {
    const statement = ccbParser.parse(makeDoc())
    const repayment = statement.transactions.find((tx) => tx.rawDescription.includes('转账还款'))
    expect(repayment!.direction).toBe('credit')
    expect(repayment!.transactionAmountMinor).toBe(-300000)

    const purchase = statement.transactions.find((tx) => tx.rawDescription.includes('示例餐厅'))
    expect(purchase!.direction).toBe('debit')
    expect(purchase!.transactionAmountMinor).toBeGreaterThan(0)
  })

  it('credit rows total the 还款/退货/费用返还 component', () => {
    const statement = ccbParser.parse(makeDoc())
    const credits = statement.transactions.filter((tx) => tx.direction === 'credit')
    expect(-credits.reduce((sum, tx) => sum + tx.settlementAmountMinor, 0)).toBe(SYNTHETIC_CCB.newCreditMinor)
  })

  it('separates the original installment purchase from the per-cycle posting', () => {
    const statement = ccbParser.parse(makeDoc())
    const original = statement.transactions.filter((tx) => tx.type === 'installment_original')
    expect(original).toHaveLength(1)
    expect(original[0]!.settlementAmountMinor).toBe(SYNTHETIC_CCB.installmentOriginalMinor)

    const perCycle = statement.transactions.filter((tx) => tx.type === 'installment_payment')
    expect(perCycle).toHaveLength(1)
    expect(perCycle[0]!.settlementAmountMinor).toBe(SYNTHETIC_CCB.installmentPaymentMinor)
  })

  it('new spending equals the debit rows minus the original installment purchase', () => {
    const statement = ccbParser.parse(makeDoc())
    const counted = statement.transactions
      .filter((tx) => tx.direction === 'debit' && tx.type !== 'installment_original')
      .reduce((sum, tx) => sum + tx.settlementAmountMinor, 0)
    expect(counted).toBe(SYNTHETIC_CCB.newDebitMinor)
  })

  it('keeps identical same-day same-merchant rows separate', () => {
    const statement = ccbParser.parse(makeDoc())
    const duplicates = statement.transactions.filter(
      (tx) => tx.settlementAmountMinor === 10000 && tx.direction === 'debit',
    )
    expect(duplicates).toHaveLength(2)
  })

  it('parses combined and split amount cells', () => {
    expect(parseCombinedAmount('12.34/CNY')).toEqual({ currency: 'CNY', minor: 1234, negative: false })
    expect(parseCombinedAmount('-12.34/CNY')).toEqual({ currency: 'CNY', minor: 1234, negative: true })
    expect(parseCombinedAmount('-')).toBeNull()
  })

  it('repeating the import does not create duplicate transactions', () => {
    const parsed = ccbParser.parse(makeDoc())
    const first = ingestParsedStatement(
      parsed,
      { fileName: 'synthetic-ccb.eml', fileHash: 'hash-ccb', fileSize: 1, sourceType: 'eml' },
      EMPTY,
    )
    expect(first.record.status).toBe('parsed')
    const second = ingestParsedStatement(
      parsed,
      { fileName: 'synthetic-ccb.eml', fileHash: 'hash-ccb', fileSize: 1, sourceType: 'eml' },
      { statements: [first.statement!], transactions: first.transactions, imports: [first.record] },
    )
    expect(second.record.status).toBe('duplicate')
    expect(second.inserted).toHaveLength(0)
  })

  it('fails loudly when the statement has no transaction table', () => {
    const html = '<html><body><table><tr><td>与账单无关的通知</td></tr></table></body></html>'
    expect(() => ccbParser.parse(makeDoc(html))).toThrowError(/未找到交易明细表头/)
  })
})
