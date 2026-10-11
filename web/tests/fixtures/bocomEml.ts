/**
 * Synthetic Bank of Communications e-mail statement (HTML).
 *
 * The structure mirrors the real template - nested tables, a credit section in its
 * own table *before* the transaction table, the summary equation block and an
 * installment plan table - but every amount, name and card number is invented.
 *
 * Reconciliation targets for this fixture:
 *   3000.00 (previous) + 6500.00 (spending) - 7200.00 (credits) = 2300.00
 * where 新增消费 6500.00 = all debit rows minus the original installment purchase
 * (900.00) and minus nothing else; 分期扣款 300.00 is counted as new spending.
 */

const rows = (cells: string[]): string => `<tr>${cells.map((cell) => `<td>${cell}</td>`).join('')}</tr>`

const TXN_HEADER = [
  '',
  '交易 日期 Transaction Date',
  '记账 日期 Posting Date',
  '卡末 四位 Card Number (Last 4 digits)',
  '交易 说明 Description of Transaction',
  '交易 金额 Transaction Curr/Amt',
  '入账 金额 Payment Curr/Amt',
]

export const SYNTHETIC_BOCOM_HTML = `
<html>
  <head><style>.x{color:red}</style></head>
  <body>
    <img src="https://tracker.example.com/pixel.gif" width="1" height="1" />
    <table>${rows(['尊敬的张示例先生：以下是您的 2026年08月 信用卡电子账单。'])}</table>
    <table>${rows(['交通银行个人信用卡 622260******9876 账单周期 Statement Cycle', '2026/07/15-2026/08/14'])}</table>
    <table>
      ${rows(['到期还款日 Payment Due Date', '2026-09-08'])}
      ${rows(['本期应还款', '￥2300.00', '＄---', 'Statement Balance 负数代表账户有溢缴款'])}
      ${rows(['最低应还款', '￥185.00', '＄---', 'Minimum Payment Due'])}
    </table>
    <table>${rows(['信用额度 Credit Limit', '￥20000', '＄---'])}</table>
    <table>
      ${rows([
        '本期应还款 Statement Balance',
        '=',
        '上期应还款 Last Statement Balance',
        '-',
        '还款、退货、费用返还 Payment、Credit',
        '+',
        '消费、 取现 New Spending 、Cash advance',
        '+',
        '费用 Charges',
        '+',
        '利息 Interest',
      ])}
      ${rows(['&yen;2300.00', '', '&yen;3000.00', '', '&yen;7200.00', '', '&yen;6500.00', '', '&yen;0.00', '', '&yen;0.00'])}
      ${rows(['$0.00', '', '$0.00', '', '$0.00', '', '$0.00', '', '$0.00', '', '$0.00'])}
    </table>

    <table>
      ${rows(['还款、退货、费用返还明细'])}
      ${rows(TXN_HEADER)}
      ${rows(['', '07/17', '07/17', '9876', '信用卡还款 转账还款-示例银行-张示例 尾号1234', 'CNY 3000.00', 'CNY 3000.00'])}
      ${rows(['', '08/14', '08/14', '9876', '退货 支付宝-示例电商有限公司', 'CNY 2400.00', 'CNY 2400.00'])}
      ${rows(['', '08/14', '08/14', '9876', '退货 支付宝-示例电商有限公司', 'CNY 1800.00', 'CNY 1800.00'])}
    </table>

    <table>
      ${rows(TXN_HEADER)}
      ${rows(['', '07/16', '07/16', '9876', '消费 商户分期-支付宝-示例通讯-示例通讯-分3期', 'CNY 900.00', 'CNY 900.00'])}
      ${rows(['', '07/16', '07/16', '9876', '分期扣款 1/3期-商户分期-支付宝-示例通讯-示例通讯-分3期', 'CNY 300.00', 'CNY 300.00'])}
      ${rows(['', '07/20', '07/20', '9876', '消费 支付宝-示例餐厅', 'CNY 68.00', 'CNY 68.00'])}
      ${rows(['', '07/22', '07/22', '9876', '消费 财付通-示例商城', 'CNY 1200.00', 'CNY 1200.00'])}
      ${rows(['', '07/25', '07/25', '9876', '消费 支付宝-示例生鲜', 'CNY 86.50', 'CNY 86.50'])}
      ${rows(['', '08/02', '08/02', '9876', '消费 财付通-示例电商有限公司', 'CNY 2400.00', 'CNY 2400.00'])}
      ${rows(['', '08/02', '08/02', '9876', '消费 财付通-示例电商有限公司', 'CNY 1800.00', 'CNY 1800.00'])}
      ${rows(['', '08/06', '08/06', '9876', '消费 支付宝-示例出行', 'CNY 34.20', 'CNY 34.20'])}
      ${rows(['', '08/09', '08/09', '9876', '消费 支付宝-示例超市', 'CNY 411.30', 'CNY 411.30'])}
      ${rows(['', '08/09', '08/09', '9876', '消费 支付宝-示例超市', 'CNY 100.00', 'CNY 100.00'])}
      ${rows(['', '08/09', '08/09', '9876', '消费 支付宝-示例超市', 'CNY 100.00', 'CNY 100.00'])}
    </table>

    <table>
      ${rows(['除以上账单显示交易外，截至账单日您的剩余分期本金为 ￥600.00，＄0.00'])}
      ${rows(['分期 时间', '分期 产品描述', '剩余本金/ 分期总金额', '剩余期数/ 总期数', '剩余利息/ 分期总利息'])}
      ${rows(['2026-07-16', '商户分期', '￥600.00/￥900.00', '2/3', '￥0.00/￥0.00'])}
    </table>

    <table>${rows(['温馨提示', '请妥善保管密码等个人信息。'])}</table>
  </body>
</html>
`

export const SYNTHETIC_BOCOM = {
  cardLast4: '9876',
  cycleStart: '2026-07-15',
  cycleEnd: '2026-08-14',
  dueDate: '2026-09-08',
  previousBalanceMinor: 300000,
  newCreditMinor: 720000,
  newDebitMinor: 650000,
  currentBalanceMinor: 230000,
  minimumPaymentMinor: 18500,
  creditTransactionCount: 3,
  debitTransactionCount: 11,
  installmentOriginalMinor: 90000,
  installmentPaymentMinor: 30000,
  totalDebitRowsMinor: 710000,
  expectedSpendingMinor: 650000,
}