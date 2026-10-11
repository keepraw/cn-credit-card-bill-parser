import type { Category, Direction, TransactionType } from './types'

/**
 * Transaction type inference.
 *
 * Priority order (never merchant-name guessing):
 *   1. The bank's own structured type token (BOCOM puts 消费 / 还款 / 分期扣款 in the
 *      description prefix; BOC uses the Deposit / Expenditure column).
 *   2. The column / section the row was found in (debit vs credit).
 *   3. A short, bounded keyword list for statements without a structured token.
 *
 * The signed amount is always derived from `direction`, which comes from the bank
 * column or section - never from the description.
 */

const TYPE_TOKENS: Array<[RegExp, TransactionType]> = [
  [/^分期利息|分期手续费/, 'interest'],
  [/^分期扣款|每期入账|分期入账/, 'installment_payment'],
  [/^分期(消费)?原始|^商户分期(?!扣款)|^消费\s*商户分期/, 'installment_original'],
  [/^信用卡还款|还款|转账还款|自助还款|网上还款/, 'payment'],
  [/^退货|退款|退汇/, 'refund'],
  [/^刷卡金|返现|返还|积分兑换|优惠/, 'cashback'],
  [/^手续费|年费|服务费|短信服务费|短信费|违约金/, 'fee'],
  [/^利息|透支利息|计息/, 'interest'],
  [/^取现|预借现金/, 'cash_advance'],
  [/^消费|购物|支付/, 'purchase'],
  [/^调整|冲正|其他/, 'adjustment'],
]

export function inferTransactionType(bankToken: string, description: string, direction: Direction): TransactionType {
  const token = (bankToken ?? '').trim()
  const head = token || (description ?? '').trim()
  if (head) {
    for (const [re, type] of TYPE_TOKENS) {
      if (re.test(head)) return type
    }
  }
  // No structured token: fall back to the direction only, never to merchant names.
  return direction === 'debit' ? 'purchase' : 'payment'
}

/** Business types that increase the card balance. */
export const DEBIT_TYPES: ReadonlySet<TransactionType> = new Set<TransactionType>([
  'purchase',
  'cash_advance',
  'fee',
  'interest',
  'installment_payment',
])

/**
 * Installment bookkeeping: some banks show both the original purchase and the
 * per-instalment posting in the same cycle. Summing both double counts spending,
 * so only `installment_payment` counts as real new spending.
 */
export const SPENDING_TYPES: ReadonlySet<TransactionType> = new Set<TransactionType>(['purchase', 'cash_advance'])

const CATEGORY_RULES: Array<{ category: Category; re: RegExp }> = [
  { category: '餐饮', re: /(餐|food|restaurant|餐饮|food|tea|coffee|咖啡|茶|外卖|美团饿了么|kitchen|dining)/i },
  { category: '交通出行', re: /(uber|滴滴|taxi|地铁|公交|加油|中石化|中石油|停车|高铁|12306|出行|metro|gas|flight|机票)/i },
  { category: '购物', re: /(商城|购物|超市|便利店|淘宝|天猫|京东|拼多多|商场|amazon|taobao|jd|shop)/i },
  { category: '生活缴费', re: /(电费|水费|燃气|物业|话费|充值|utility|水电)/i },
  { category: '医疗健康', re: /(医院|药房|药店|医药|挂号|clinic|pharmacy|health)/i },
  { category: '教育', re: /(学费|书店|教育|培训|course|book)/i },
  { category: '住房', re: /(房租|租金|公寓|房贷|rent)/i },
  { category: '旅行', re: /(携程|酒店|旅行社|住宿|travel|hotel|airbnb|trip)/i },
  { category: '订阅服务', re: /(会员|订阅|subscription|netflix|icloud|优酷|腾讯视频|爱奇艺)/i },
]

export function inferCategory(description: string, type: TransactionType): Category {
  if (type === 'payment') return '还款'
  if (type === 'refund') return '退款'
  const text = description ?? ''
  for (const rule of CATEGORY_RULES) {
    if (rule.re.test(text)) return rule.category
  }
  if (type === 'purchase' || type === 'installment_payment' || type === 'installment_original') return '未分类'
  return '其他'
}

/** Extract a merchant-ish label from a raw bank description. */
export function extractMerchant(description: string): string {
  const text = (description ?? '').trim()
  if (!text) return ''
  const withoutPrefix = text.replace(/^(消费|取现|还款|退款|退货|返现|手续费|利息|调整|刷卡金)\s*/, '')
  const parts = withoutPrefix.split(/[-–—:：]/).filter(Boolean)
  const candidate = parts.length > 1 ? parts.slice(1).join('-') : withoutPrefix
  return candidate.length > 40 ? candidate.slice(0, 40) : candidate
}

export function signForDirection(minor: number, direction: Direction): number {
  return direction === 'debit' ? Math.abs(minor) : -Math.abs(minor)
}

export function directionForSignedAmount(minor: number): Direction {
  return minor < 0 ? 'credit' : 'debit'
}