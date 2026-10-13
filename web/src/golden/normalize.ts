/**
 * Golden normalization adapter (Task A-3.4).
 *
 * Converts already-parsed statements into golden/v1. Imports parsers and core
 * helpers read-only; changes nothing about them.
 */

import { normalizeDescription } from '../core/identity'
import type { ParsedStatement, ParsedTransaction } from '../parsers/types'
import { GOLDEN_GENERATOR_WEB, GOLDEN_SCHEMA, type Direction, type GoldenStatement, type NormalizedTransaction } from './schema'

/** 32-bit FNV-1a hex. Must stay identical to `golden.py::fnv1a32`. */
export function fnv1a32(text: string): string {
  let digest = 0x811c9dc5
  const bytes = new TextEncoder().encode(text)
  for (const byte of bytes) {
    digest ^= byte
    digest = Math.imul(digest, 0x01000193) >>> 0
  }
  return digest.toString(16).padStart(8, '0')
}

/**
 * Leading structural tokens kept verbatim (same list and order as the Python
 * adapter so longest-prefix matching behaves identically).
 */
export const KNOWN_PREFIXES = [
  '网上消费退货',
  '网上消费',
  '手机银行',
  '按卡转账还款',
  '跨行二维码支付',
  '转账还款',
  '信用卡还款',
  '自助还款',
  '网上还款',
  '分期扣款',
  '分期利息',
  '分期手续费',
  '每期入账',
  '分期入账',
  '商户分期',
  '银联入账',
  '银联转账',
  '网银转账',
  '网银在线',
  '卡卡转账',
  '刷卡金',
  '预借现金',
  '消费',
  '取现',
  '还款',
  '退货',
  '退款',
  '退汇',
  '返现',
  '返还',
  '利息',
  '手续费',
  '年费',
  '服务费',
  '违约金',
  '调整',
  '冲正',
  '转账',
  '存入',
  '支出',
  '贷方',
  '借记',
  '贷记',
] as const

const STRUCTURAL_KEYWORDS = [
  '中国农业银行',
  '中国建设银行',
  '中国工商银行',
  '中国银行',
  '交通银行',
  '中信银行',
  '农业银行',
  '建设银行',
  '工商银行',
  '信用卡',
  '电子账单',
  '电子对账单',
  '客户对账单',
  '账单周期',
  '交易明细',
  '交易日期',
  '入账日期',
  '银行记账日',
  '交易日',
  '记账日',
  '卡号后四位',
  '交易描述',
  '交易金额',
  '记账金额',
  '币种',
  '还款',
  '退货',
  '退款',
  '消费',
  '取现',
  '存入',
  '支出',
  '温馨提示',
  '积分统计',
  '刷卡金统计',
] as const

const CJK_RUN = /[一-鿿]{2,}/g
const LONG_DIGITS = /\d{16,}/g
const LATIN_RUN = /[A-Za-z]{3,}/g
/** Latin tokens kept verbatim in debug rawText (currencies, bank ids, signs). */
const LATIN_ALLOW = new Set([
  'CNY', 'RMB', 'USD', 'HKD', 'CHN', 'EUR', 'JPY', 'GBP', 'AUD',
  'CAD', 'SGD', 'CHF', 'CR', 'DR',
  'BOC', 'BOCOM', 'ICBC', 'CCB', 'ABC', 'CITIC',
])

function splitPrefix(description: string): [string, string] {
  for (const prefix of KNOWN_PREFIXES) {
    if (description.startsWith(prefix)) return [prefix, description.slice(prefix.length).trim()]
  }
  return ['', description.trim()]
}

/** Keep structural prefix; hash the remainder so distinct merchants stay distinct. */
export function desensitizeDescription(description: string): string {
  const text = (description ?? '').replace(/\u00a0/g, ' ').trim().replace(/\s*\/\s*$/, '').trim()
  if (!text) return text
  const [prefix, rest] = splitPrefix(text)
  if (!rest) return prefix
  const key = rest.replace(/\s+/g, ' ').trim()
  const placeholder = `商户_${fnv1a32(key)}`
  return prefix ? `${prefix} ${placeholder}` : placeholder
}

/** Mask non-structural CJK runs and long digit runs; keep layout/amounts/dates. */
export function desensitizeRawText(rawText: string): string {
  if (!rawText) return rawText
  const masked = rawText.replace(CJK_RUN, (run) => {
    if (STRUCTURAL_KEYWORDS.some((keyword) => run.includes(keyword))) return run
    for (const prefix of KNOWN_PREFIXES) {
      if (run.startsWith(prefix)) return prefix + (run.length > prefix.length ? '██' : '')
    }
    return '██'
  })
  const latinMasked = masked.replace(LATIN_RUN, (run) => (LATIN_ALLOW.has(run.toUpperCase()) ? run : '██'))
  return latinMasked.replace(LONG_DIGITS, '****************')
}

export function directionForMinor(minor: number): Direction {
  return minor < 0 ? 'credit' : 'debit'
}

export function normalizeWebTransaction(
  tx: ParsedTransaction,
  fingerprint: string,
  statementKey: string,
  seq: number,
  options: { desensitize?: boolean; bank?: string } = {},
): NormalizedTransaction {
  const desensitize = options.desensitize ?? true
  const description = desensitize ? desensitizeDescription(tx.description) : tx.description
  return {
    bank: options.bank ?? '',
    cardLast4: tx.cardLast4 ?? '',
    transactionDate: tx.transactionDate ?? '',
    postingDate: tx.postingDate ?? tx.transactionDate ?? '',
    amountMinor: tx.settlementAmountMinor,
    currency: (tx.settlementCurrency || 'CNY').toUpperCase(),
    direction: directionForMinor(tx.settlementAmountMinor),
    description,
    normalizedDescription: normalizeDescription(description),
    rawText: desensitize ? desensitizeRawText(tx.rawText) : tx.rawText,
    sourcePosition: { row: seq, page: tx.sourcePage, sourceRow: tx.sourceRow },
    nativeId: fingerprint,
    statementKey,
  }
}

export function normalizeWebStatement(
  statement: ParsedStatement,
  fingerprints: string[],
  options: { desensitize?: boolean } = {},
): GoldenStatement {
  const key = `${statement.bank}:${statement.cardLast4}:${statement.cycleStart ?? ''}:${statement.cycleEnd ?? ''}`
  const transactions = statement.transactions.map((tx, index) =>
    normalizeWebTransaction(tx, fingerprints[index] ?? '', key, index, { desensitize: options.desensitize, bank: statement.bank }),
  )
  return {
    schema: GOLDEN_SCHEMA,
    origin: 'web',
    generator: GOLDEN_GENERATOR_WEB,
    bank: statement.bank,
    bankNative: statement.bank,
    cardLast4: statement.cardLast4 ?? '',
    cycleStart: statement.cycleStart,
    cycleEnd: statement.cycleEnd,
    parserName: statement.parserId,
    desensitized: options.desensitize ?? true,
    nativeIds: { transactionAlgo: 'fnv1a-dual-lane', occurrence: 'fingerprint#N' },
    transactionCount: transactions.length,
    transactions,
  }
}
