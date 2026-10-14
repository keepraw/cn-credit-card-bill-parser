import { SPENDING_TYPES } from './classify'
import { formatMinor, normalizeCurrencyCode } from './money'
import type { ReconciliationCheck, ReconciliationResult, StatementSummary, Transaction } from './types'

/**
 * Statement reconciliation.
 *
 * Parsing transactions successfully is NOT enough to call a statement correct.
 * Three independent checks run for every statement:
 *
 *   1. balance_equation  本期余额 = 上期余额 + 本期支出 + 费用 + 利息 − 本期还款及其他贷记
 *   2. debit_detail      sum of debit transactions vs 本期新增支出
 *   3. credit_detail     sum of credit transactions vs 本期还款及其他贷记
 *
 * Any mismatch, or missing summary data, yields `mismatch` / `insufficient` and the
 * statement is routed to manual review instead of being folded into the statistics.
 */

export interface ReconcileInput {
  summary: StatementSummary
  transactions: Transaction[]
}

export function reconcileStatement(input: ReconcileInput): ReconciliationResult {
  const { summary, transactions } = input
  const checks: ReconciliationCheck[] = []
  const currency = summary.components[0]?.currency ?? 'CNY'

  const active = transactions.filter((tx) => tx.reviewStatus !== 'rejected')
  const otherCurrencies = active.filter((tx) => normalizeCurrencyCode(tx.settlementCurrency) !== normalizeCurrencyCode(currency))
  if (otherCurrencies.length > 0) {
    checks.push({
      id: 'other_currencies', label: '其他结算币种单独保留', status: 'skipped',
      expectedMinor: null, actualMinor: null, differenceMinor: null,
      detail: `${otherCurrencies.length} 笔非 ${currency} 结算交易未纳入本次 ${currency} 对账；未进行汇率换算`,
    })
  }

  // --- 1. balance equation -------------------------------------------------
  const hasPrevious = summary.previousBalanceMinor !== null
  const hasCurrent = summary.currentBalanceMinor !== null
  if (!hasPrevious || !hasCurrent) {
    checks.push({
      id: 'balance_equation',
      label: '本期余额 = 上期余额 + 本期支出 + 费用 + 利息 − 本期还款及其他贷记',
      status: 'missing',
      expectedMinor: null,
      actualMinor: null,
      differenceMinor: null,
      detail: `账单缺少${!hasPrevious ? '上期余额' : ''}${!hasPrevious && !hasCurrent ? '和' : ''}${
        !hasCurrent ? '本期应还金额' : ''
      }，无法完成对账`,
    })
  } else {
    const debit = summary.newDebitMinor ?? 0
    const credit = summary.newCreditMinor ?? 0
    const charge = summary.chargeMinor ?? 0
    const interest = summary.interestMinor ?? 0
    // 本期余额 = 上期余额 + 本期新增支出 + 费用 + 利息 − 本期还款及其他贷记
    const computed = summary.previousBalanceMinor! + debit + charge + interest - credit
    const difference = summary.currentBalanceMinor! - computed
    checks.push({
      id: 'balance_equation',
      label: '本期余额 = 上期余额 + 本期支出 + 费用 + 利息 − 本期还款及其他贷记',
      status: difference === 0 ? 'passed' : 'mismatch',
      expectedMinor: computed,
      actualMinor: summary.currentBalanceMinor,
      differenceMinor: difference,
      detail:
        difference === 0
          ? `${formatMinor(computed, currency)} 与账单本期应还一致`
          : `按账单汇总计算应为 ${formatMinor(computed, currency)}，账单显示 ${formatMinor(
              summary.currentBalanceMinor!,
              currency,
            )}，差额 ${formatMinor(difference, currency)}`,
    })
  }

  // --- 2. new spending detail ----------------------------------------------
  checks.push(
    detailCheck(
      'debit_detail',
      '交易明细消费/取现/分期入账合计 = 本期新增支出',
      'debit',
      summary.newDebitMinor,
      active,
      currency,
      SPENDING_DETAIL_TYPES,
    ),
  )

  // --- 3. charges and interest ---------------------------------------------
  if (summary.chargeMinor !== null || summary.interestMinor !== null) {
    checks.push({
      id: 'charges_detail',
      label: '交易明细手续费/利息合计 = 本期费用 + 利息',
      status: 'skipped',
      expectedMinor: (summary.chargeMinor ?? 0) + (summary.interestMinor ?? 0),
      actualMinor: null,
      differenceMinor: null,
      detail: '',
    })
    const chargeCheck = checks[checks.length - 1]!
    const relevant = active.filter(
      (tx) => tx.direction === 'debit' && tx.settlementCurrency === currency && CHARGE_DETAIL_TYPES.has(tx.type),
    )
    const actual = relevant.reduce((sum, tx) => sum + tx.settlementAmountMinor, 0)
    const difference = (summary.chargeMinor ?? 0) + (summary.interestMinor ?? 0) - actual
    chargeCheck.status = difference === 0 ? 'passed' : 'mismatch'
    chargeCheck.actualMinor = actual
    chargeCheck.differenceMinor = difference
    chargeCheck.detail =
      difference === 0
        ? `${relevant.length} 笔合计 ${formatMinor(actual, currency)}，与账单一致`
        : `${relevant.length} 笔合计 ${formatMinor(actual, currency)}，账单费用+利息为 ${formatMinor(
            (summary.chargeMinor ?? 0) + (summary.interestMinor ?? 0),
            currency,
          )}，差额 ${formatMinor(difference, currency)}`
  }

  // --- 4. credit detail ----------------------------------------------------
  checks.push(
    detailCheck(
      'credit_detail',
      '交易明细还款/退货/返还合计 = 本期还款及其他贷记',
      'credit',
      summary.newCreditMinor,
      active,
      currency,
      CREDIT_DETAIL_TYPES,
    ),
  )

  // --- 5. transaction count ------------------------------------------------
  if (active.length === 0) {
    checks.push({
      id: 'transaction_count',
      label: '账单至少包含一笔交易',
      status: 'missing',
      expectedMinor: null,
      actualMinor: 0,
      differenceMinor: null,
      detail: '没有解析到任何交易',
    })
  } else {
    checks.push({
      id: 'transaction_count',
      label: '账单至少包含一笔交易',
      status: 'passed',
      expectedMinor: null,
      actualMinor: active.length,
      differenceMinor: null,
      detail: `共 ${active.length} 笔交易`,
    })
  }

  const hasMissing = checks.some((check) => check.status === 'missing')
  const hasMismatch = checks.some((check) => check.status === 'mismatch')
  const status: ReconciliationResult['status'] = hasMismatch ? 'mismatch' : hasMissing ? 'insufficient' : 'passed'

  return { status, checks, computedBalanceMinor: checks.find((check) => check.id === 'balance_equation')?.actualMinor ?? null }
}

/** Transaction types that make up the bank's 新增消费 / New Spending line. */
const SPENDING_DETAIL_TYPES: ReadonlySet<Transaction['type']> = new Set<Transaction['type']>([
  'purchase',
  'cash_advance',
  'installment_payment',
  'adjustment',
])

/** Transaction types the bank books as 费用 / 利息. */
const CHARGE_DETAIL_TYPES: ReadonlySet<Transaction['type']> = new Set<Transaction['type']>(['fee', 'interest'])

/** Transaction types that make up 还款、退货、费用返还. */
const CREDIT_DETAIL_TYPES: ReadonlySet<Transaction['type']> = new Set<Transaction['type']>([
  'payment',
  'refund',
  'cashback',
  'adjustment',
])

function detailCheck(
  id: string,
  label: string,
  direction: 'debit' | 'credit',
  expected: number | null,
  transactions: Transaction[],
  currency: string,
  types: ReadonlySet<Transaction['type']>,
): ReconciliationCheck {
  if (expected === null) {
    return {
      id,
      label,
      status: 'missing',
      expectedMinor: null,
      actualMinor: null,
      differenceMinor: null,
      detail: '账单缺少该分项的汇总金额，无法核对交易明细',
    }
  }

  const relevant = transactions.filter((tx) => {
    if (tx.direction !== direction) return false
    if (tx.settlementCurrency !== currency) return false
    // A bank may print both the original installment purchase and the per-cycle
    // posting. Only the per-cycle posting counts as new spending.
    if (tx.type === 'installment_original') return false
    return types.has(tx.type)
  })

  // Credit rows are stored as negative amounts, so compare magnitudes.
  const actual = relevant.reduce((sum, tx) => sum + (tx.direction === 'credit' ? -tx.settlementAmountMinor : tx.settlementAmountMinor), 0)
  const difference = expected - actual
  return {
    id,
    label,
    status: difference === 0 ? 'passed' : 'mismatch',
    expectedMinor: expected,
    actualMinor: actual,
    differenceMinor: difference,
    detail:
      difference === 0
        ? `${relevant.length} 笔合计 ${formatMinor(actual, currency)}，与账单一致`
        : `${relevant.length} 笔合计 ${formatMinor(actual, currency)}，账单分项为 ${formatMinor(
            expected,
            currency,
          )}，差额 ${formatMinor(difference, currency)}`,
  }
}

/**
 * Real spending vs. billing movement.
 *
 * - real spending: what actually left the wallet (installment originals excluded)
 * - billing: the amount the bank posted to this cycle's balance
 */
export interface SpendingBreakdown {
  spendingMinor: number
  cashAdvanceMinor: number
  installmentPaymentMinor: number
  refundMinor: number
  cashbackMinor: number
  feeMinor: number
  interestMinor: number
  paymentMinor: number
  adjustmentMinor: number
  realSpendingMinor: number
  billingDebitMinor: number
  billingCreditMinor: number
  netMinor: number
}

export function summarizeTransactions(transactions: Transaction[], currency = 'CNY'): SpendingBreakdown {
  const result: SpendingBreakdown = {
    spendingMinor: 0,
    cashAdvanceMinor: 0,
    installmentPaymentMinor: 0,
    refundMinor: 0,
    cashbackMinor: 0,
    feeMinor: 0,
    interestMinor: 0,
    paymentMinor: 0,
    adjustmentMinor: 0,
    realSpendingMinor: 0,
    billingDebitMinor: 0,
    billingCreditMinor: 0,
    netMinor: 0,
  }

  for (const tx of transactions) {
    if (tx.reviewStatus === 'rejected') continue
    // Minor units from different settlement currencies must never be added.
    if (normalizeCurrencyCode(tx.settlementCurrency) !== normalizeCurrencyCode(currency)) continue
    const amount = tx.settlementAmountMinor
    if (tx.type === 'purchase') result.spendingMinor += amount
    else if (tx.type === 'cash_advance') result.cashAdvanceMinor += amount
    else if (tx.type === 'installment_payment') result.installmentPaymentMinor += amount
    else if (tx.type === 'refund') result.refundMinor += amount
    else if (tx.type === 'cashback') result.cashbackMinor += amount
    else if (tx.type === 'fee') result.feeMinor += amount
    else if (tx.type === 'interest') result.interestMinor += amount
    else if (tx.type === 'payment') result.paymentMinor += amount
    else result.adjustmentMinor += amount

    if (tx.type === 'installment_original') continue
    if (tx.direction === 'debit') result.billingDebitMinor += amount
    else result.billingCreditMinor += -amount
  }

  result.realSpendingMinor =
    result.spendingMinor + result.cashAdvanceMinor + result.installmentPaymentMinor
  result.netMinor = result.billingDebitMinor - result.billingCreditMinor
  return result
}

export function isSpendingType(type: Transaction['type']): boolean {
  return SPENDING_TYPES.has(type)
}
