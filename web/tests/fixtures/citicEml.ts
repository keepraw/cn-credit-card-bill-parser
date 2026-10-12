/**
 * Synthetic CITIC e-mail statement (HTML).
 *
 * Mirrors the real 动卡空间 template (greeting with cycle sentence, 总账信息
 * current/minimum rows, 卡片账单金额明细 equation table with a masked card
 * row, 8-cell transaction table with compact YYYYMMDD dates and
 * `CNY <amount>` legs) with invented data.
 *
 * Reconciliation: 10000.00 (previous) + 2100.00 (new) - 10000.00 (payments)
 * = 2100.00 (current), where 2100.00 is exactly the debit rows and 10000.00
 * is exactly the repayment row.
 */

const rows = (cells: string[]): string => `<tr>${cells.map((cell) => `<td>${cell}</td>`).join('')}</tr>`

const TXN_HEADER = ['交易日', '银行记账日', '卡号后四位', '交易描述', '', '交易货币/金额', '记账货币/金额']

export const SYNTHETIC_CITIC_HTML = `
<html>
  <body>
    <table>${rows(['', '尊敬的示例*户先生：', ''])}</table>
    <table>${rows(['', '感谢您使用中信银行信用卡，2026年08月账单已产生，记录了您2026年07月15日至2026年08月14日账户变动信息。', ''])}</table>
    <table>${rows(['总账信息', '|', 'Statement Information'])}</table>
    <table>${rows(['本期应还款总额', '', 'CNY 2100.00'])}</table>
    <table>${rows(['本期最低还款额', '', 'CNY 105.00'])}</table>
    <table>${rows(['账单日', '2026年08月14日'])}</table>
    <table>${rows(['到期还款日', '2026年09月02日'])}</table>
    <table>${rows(['', '【卡片账单金额明细】', ''])}</table>
    <table>
      ${rows(['', '卡号', '', '上期应还款额', '-', '上期已还款额', '+', '本期新增金额', '=', '账户账单金额', '', '最低还款额', ''])}
      ${rows(['', '4310-06**-****-543', 'CNY', '10000.00', '', '10000.00', '', '2100.00', '', '2100.00', '', '105.00', ''])}
    </table>
    <table>${rows(['', '【本期账务明细】'])}</table>
    <table>${rows(['', '卡号 4310-06**-****-543', ''])}</table>
    <table>
      ${rows(['', ...TXN_HEADER])}
      ${rows(['', 'Trans Date', 'Post Date', 'Card Number', 'Description', '', 'Trx.Amt', 'Setl.Amt'])}
    </table>
    <table>${rows(['主卡：示例*户', 'CNY交易'])}</table>
    <table>
      ${rows(['20260717', '20260717', '6543', '', '多渠道还款', 'CNY -10000.00', 'CNY -10000.00'])}
      ${rows(['20260720', '20260720', '6543', '', '财付通－示例餐厅', 'CNY 1200.00', 'CNY 1200.00'])}
      ${rows(['20260805', '20260805', '6543', '', '支付宝－示例商城', 'CNY 800.00', 'CNY 800.00'])}
      ${rows(['20260809', '20260809', '6543', '', '财付通－返利体验店', 'CNY 50.00', 'CNY 50.00'])}
      ${rows(['20260809', '20260809', '6543', '', '财付通－返利体验店', 'CNY 50.00', 'CNY 50.00'])}
    </table>
    <table>${rows(['', '【温馨提示】'])}</table>
  </body>
</html>
`

export const SYNTHETIC_CITIC = {
  cardLast4: '6543',
  cycleStart: '2026-07-15',
  cycleEnd: '2026-08-14',
  dueDate: '2026-09-02',
  previousBalanceMinor: 1000000,
  newCreditMinor: 1000000,
  newDebitMinor: 210000,
  currentBalanceMinor: 210000,
  minimumPaymentMinor: 10500,
  transactionCount: 5,
}
