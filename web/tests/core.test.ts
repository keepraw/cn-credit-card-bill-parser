import { describe, expect, it } from 'vitest'
import { currencyExponent, formatMinor, minorToDecimalString, parseAmountToMinor, sumMinor } from '../src/core/money'
import { addDays, addMonths, parseDateInput, resolveShortDate } from '../src/core/dates'
import { inferCategory, inferTransactionType } from '../src/core/classify'

describe('money: integer minor units only', () => {
  it('parses bank formats into exact integer minor units', () => {
    expect(parseAmountToMinor('1499.58')!.minor).toBe(149958)
    expect(parseAmountToMinor('1,234.56')!.minor).toBe(123456)
    expect(parseAmountToMinor('7,786.93')!.minor).toBe(778693)
    expect(parseAmountToMinor('¥6512.48')!.minor).toBe(651248)
    expect(parseAmountToMinor('CNY 12.34')!.minor).toBe(1234)
  })

  it('honours explicit negative formats', () => {
    expect(parseAmountToMinor('-45.00')!.minor).toBe(-4500)
    expect(parseAmountToMinor('45.00-')!.minor).toBe(-4500)
    expect(parseAmountToMinor('(45.00)')!.minor).toBe(-4500)
    expect(parseAmountToMinor('45.00/C')!.minor).toBe(-4500)
    expect(parseAmountToMinor('45.00CR')!.minor).toBe(-4500)
  })

  it('never accumulates floating point error', () => {
    // 0.1 + 0.2 !== 0.3 in binary floating point; minor units are exact.
    const values = Array.from({ length: 10 }, () => parseAmountToMinor('0.10')!.minor)
    expect(sumMinor(values)).toBe(100)
    expect(sumMinor(Array.from({ length: 3 }, () => 149958))).toBe(449874)
  })

  it('keeps a full decimal string in both directions', () => {
    expect(minorToDecimalString(778693)).toBe('7786.93')
    expect(minorToDecimalString(-8958)).toBe('-89.58')
    expect(formatMinor(778693)).toBe('7,786.93')
    expect(formatMinor(-8958)).toBe('-89.58')
  })

  it('honours zero-decimal currencies', () => {
    expect(currencyExponent('JPY')).toBe(0)
    expect(parseAmountToMinor('1200', 'JPY')!.minor).toBe(1200)
  })

  it('refuses ambiguous precision instead of rounding silently', () => {
    expect(parseAmountToMinor('10.005')).toBeNull()
  })

  it('rejects text without a number', () => {
    expect(parseAmountToMinor('---')).toBeNull()
    expect(parseAmountToMinor('')).toBeNull()
    expect(parseAmountToMinor(null)).toBeNull()
  })

  it('refuses to sum non-integer minor units', () => {
    expect(() => sumMinor([1.5])).toThrow()
  })
})

describe('dates', () => {
  it('parses the formats Chinese statements use', () => {
    expect(parseDateInput('2026-09-06')).toBe('2026-09-06')
    expect(parseDateInput('20260906')).toBe('2026-09-06')
    expect(parseDateInput('2026年9月6日')).toBe('2026-09-06')
    expect(parseDateInput('2026/9/6')).toBe('2026-09-06')
    expect(parseDateInput('not a date')).toBeNull()
  })

  it('rejects impossible dates', () => {
    expect(parseDateInput('2026-02-30')).toBeNull()
    expect(parseDateInput('2026-13-01')).toBeNull()
  })

  it('resolves short dates inside a cycle that crosses a year boundary', () => {
    expect(resolveShortDate('12/20', '2025-12-15', '2026-01-14')).toBe('2025-12-20')
    expect(resolveShortDate('01/05', '2025-12-15', '2026-01-14')).toBe('2026-01-05')
  })

  it('falls back to the cycle end year outside the cycle', () => {
    expect(resolveShortDate('09/20', '2025-12-15', '2026-01-14')).toBe('2026-09-20')
  })

  it('adds months and days without timezone drift', () => {
    expect(addMonths('2026-10-04', -1)).toBe('2026-09-04')
    expect(addDays('2026-09-04', 1)).toBe('2026-09-05')
    expect(addMonths('2026-03-31', -1)).toBe('2026-02-28')
  })
})

describe('classification', () => {
  it('uses the bank token, not the merchant name', () => {
    expect(inferTransactionType('消费', '消费 退款商户名称', 'debit')).toBe('purchase')
    expect(inferTransactionType('还款', '还款 某某超市', 'credit')).toBe('payment')
    expect(inferTransactionType('退货', '退货 支付宝-某商户', 'credit')).toBe('refund')
    expect(inferTransactionType('分期扣款', '分期扣款 1/3期', 'debit')).toBe('installment_payment')
    expect(inferTransactionType('分期利息', '分期利息', 'debit')).toBe('interest')
  })

  it('never flips direction because a merchant name contains a keyword', () => {
    // A purchase at a merchant whose name contains 退款 is still a debit.
    expect(inferTransactionType('消费', '消费 退款服务店', 'debit')).toBe('purchase')
  })

  it('falls back to the column direction when the bank gives no token', () => {
    expect(inferTransactionType('', '某不认识的商户', 'debit')).toBe('purchase')
    expect(inferTransactionType('', '某不认识的商户', 'credit')).toBe('payment')
  })

  it('assigns categories from the description', () => {
    expect(inferCategory('消费 支付宝-联东谷餐厅', 'purchase')).toBe('餐饮')
    expect(inferCategory('消费 财付通-京东商城', 'purchase')).toBe('购物')
    expect(inferCategory('信用卡还款 转账还款', 'payment')).toBe('还款')
  })
})