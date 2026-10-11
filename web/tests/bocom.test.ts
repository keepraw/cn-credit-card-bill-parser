import { describe, expect, it } from 'vitest'
import { bocomParser, locateCycle, locateSections, parseCurrencyAmount } from '../src/parsers/bocom'
import { extractTables, extractText, sanitizeHtml } from '../src/parsers/html'
import type { SourceDocument } from '../src/parsers/types'
import { SYNTHETIC_BOCOM, SYNTHETIC_BOCOM_HTML } from './fixtures/bocomEml'

function makeDoc(html = SYNTHETIC_BOCOM_HTML): SourceDocument {
  const safe = sanitizeHtml(html)
  return {
    fileName: 'synthetic-bocom.eml',
    fileSize: 5000,
    fileHash: 'hash-bocom',
    sourceType: 'eml',
    pdf: null,
    html: safe,
    tables: extractTables(safe),
    text: extractText(safe),
    email: { subject: '交通银行个人信用卡2026年08月电子账单', from: 'noreply@example.invalid', date: '2026-08-15' },
  }
}

describe('BOCOM EML parser', () => {
  it('recognises the bank and product', () => {
    expect(bocomParser.match(makeDoc())).toBe(1)
  })

  it('strips remote images and scripts before anything else looks at the HTML', () => {
    const safe = sanitizeHtml(SYNTHETIC_BOCOM_HTML)
    expect(safe).not.toContain('tracker.example.com')
    expect(safe).not.toContain('<img')
    expect(safe).not.toMatch(/<style/i)
  })

  it('extracts the statement cycle from the header', () => {
    const cycle = locateCycle(makeDoc())
    expect(cycle).toEqual({ start: SYNTHETIC_BOCOM.cycleStart, end: SYNTHETIC_BOCOM.cycleEnd })
  })

  it('finds the credit section table and the debit table', () => {
    const sections = locateSections(makeDoc())
    expect(sections).not.toBeNull()
    expect(sections!.creditRows).toHaveLength(SYNTHETIC_BOCOM.creditTransactionCount)
    expect(sections!.debitRows).toHaveLength(SYNTHETIC_BOCOM.debitTransactionCount)
  })

  it('extracts card last four, cycle and summary components', () => {
    const statement = bocomParser.parse(makeDoc())
    expect(statement.cardLast4).toBe(SYNTHETIC_BOCOM.cardLast4)
    expect(statement.cycleStart).toBe(SYNTHETIC_BOCOM.cycleStart)
    expect(statement.cycleEnd).toBe(SYNTHETIC_BOCOM.cycleEnd)
    expect(statement.dueDate).toBe(SYNTHETIC_BOCOM.dueDate)
    expect(statement.summary.previousBalanceMinor).toBe(SYNTHETIC_BOCOM.previousBalanceMinor)
    expect(statement.summary.newCreditMinor).toBe(SYNTHETIC_BOCOM.newCreditMinor)
    expect(statement.summary.newDebitMinor).toBe(SYNTHETIC_BOCOM.newDebitMinor)
    expect(statement.summary.currentBalanceMinor).toBe(SYNTHETIC_BOCOM.currentBalanceMinor)
  })

  it('balances the statement equation', () => {
    const { summary } = bocomParser.parse(makeDoc())
    const computed =
      summary.previousBalanceMinor! +
      summary.newDebitMinor! +
      (summary.chargeMinor ?? 0) +
      (summary.interestMinor ?? 0) -
      summary.newCreditMinor!
    expect(computed).toBe(summary.currentBalanceMinor)
  })

  it('uses the section, not the merchant text, for the direction', () => {
    const statement = bocomParser.parse(makeDoc())
    const repayment = statement.transactions.find((tx) => tx.bankToken === '信用卡还款')
    expect(repayment!.direction).toBe('credit')
    expect(repayment!.transactionAmountMinor).toBe(-300000)

    const purchase = statement.transactions.find((tx) => tx.bankToken === '消费')
    expect(purchase!.direction).toBe('debit')
    expect(purchase!.transactionAmountMinor).toBeGreaterThan(0)
  })

  it('credit rows total the 还款、退货、费用返还 component', () => {
    const statement = bocomParser.parse(makeDoc())
    const credits = statement.transactions.filter((tx) => tx.direction === 'credit')
    expect(-credits.reduce((sum, tx) => sum + tx.settlementAmountMinor, 0)).toBe(SYNTHETIC_BOCOM.newCreditMinor)
  })

  it('separates the original installment purchase from the per-cycle posting', () => {
    const statement = bocomParser.parse(makeDoc())
    const original = statement.transactions.filter((tx) => tx.type === 'installment_original')
    expect(original).toHaveLength(1)
    expect(original[0]!.settlementAmountMinor).toBe(SYNTHETIC_BOCOM.installmentOriginalMinor)

    const perCycle = statement.transactions.filter((tx) => tx.type === 'installment_payment')
    expect(perCycle).toHaveLength(1)
    expect(perCycle[0]!.settlementAmountMinor).toBe(SYNTHETIC_BOCOM.installmentPaymentMinor)
  })

  it('new spending equals the debit rows minus the original installment purchase', () => {
    const statement = bocomParser.parse(makeDoc())
    const counted = statement.transactions
      .filter((tx) => tx.direction === 'debit' && tx.type !== 'installment_original')
      .reduce((sum, tx) => sum + tx.settlementAmountMinor, 0)
    expect(counted).toBe(SYNTHETIC_BOCOM.newDebitMinor)
  })

  it('resolves MM/DD dates inside a cycle that crosses a year boundary', () => {
    const html = SYNTHETIC_BOCOM_HTML.replace('2026/07/15-2026/08/14', '2025/12/15-2026/01/14').replace(
      '<td>07/17</td><td>07/17</td>',
      '<td>01/05</td><td>01/05</td>',
    )
    expect(html).toContain('2025/12/15-2026/01/14')
    const statement = bocomParser.parse(makeDoc(html))
    expect(statement.cycleStart).toBe('2025-12-15')
    expect(statement.cycleEnd).toBe('2026-01-14')
    const payment = statement.transactions.find((tx) => tx.bankToken === '信用卡还款')
    expect(payment!.transactionDate).toBe('2026-01-05')
    expect(payment!.postingDate).toBe('2026-01-05')
  })

  it('keeps identical same-day same-merchant rows separate', () => {
    const statement = bocomParser.parse(makeDoc())
    const duplicates = statement.transactions.filter((tx) => tx.settlementAmountMinor === 10000 && tx.direction === 'debit')
    expect(duplicates).toHaveLength(2)
  })

  it('parses currency prefixes and CR/DR suffixes', () => {
    expect(parseCurrencyAmount('CNY 12.34')).toEqual({ currency: 'CNY', minor: 1234 })
    expect(parseCurrencyAmount('USD 1,200.00')).toEqual({ currency: 'USD', minor: 120000 })
    expect(parseCurrencyAmount('￥88.00')).toEqual({ currency: 'CNY', minor: 8800 })
    expect(parseCurrencyAmount('CNY 88.00CR')).toEqual({ currency: 'CNY', minor: -8800 })
    expect(parseCurrencyAmount('not an amount')).toBeNull()
  })

  it('fails loudly when the statement has no transaction table', () => {
    const html = '<html><body><table><tr><td>与账单无关的通知</td></tr></table></body></html>'
    expect(() => bocomParser.parse(makeDoc(html))).toThrowError(/未找到交易明细表头/)
  })
})