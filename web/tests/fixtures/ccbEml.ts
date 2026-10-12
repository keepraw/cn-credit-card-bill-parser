/**
 * Synthetic CCB e-mail statement (HTML).
 *
 * Mirrors the real template (equation block, per-card table, 8-column
 * currency-split transaction rows with `-` credit prefix) with invented data.
 *
 * Reconciliation: 3000.00 (previous) + 6500.00 (spending) - 7200.00 (credits) = 2300.00
 * where 6500.00 = all debit rows minus the original installment purchase (900.00);
 * 分期扣款 300.00 counts as new spending.
 */

const rows = (cells: string[]): string => `<tr>${cells.map((cell) => `<td>${cell}</td>`).join('')}</tr>`

const TXN_HEADER_CN = ['交易日', '银行记账日', '卡号后四位', '交易描述', '交易币/金额', '结算币/金额']
const TXN_HEADER_EN = ['T-Date', 'P-Date', 'Card Number', 'Description', 'Trans.Curr/Amt', 'Sett.Curr/Amt']

export const SYNTHETIC_CCB_HTML = `
<html>
  <body>
    <table>${rows(['尊敬的示例先生，您好！感谢使用中国建设银行龙卡信用卡，以下为您2026年07月15日至2026年08月14日信用卡账户变动情况。'])}</table>
    <table>
      ${rows(['账户币种Currency', '上期全部应还款额Last Statement Balance', '+', '消费/取现/其它费用New Spending/Cash advance/Charges', '-', '还款/退货/费用返还Payment/Credit', '=', '本期全部应还款额New Balance'])}
      ${rows(['人民币（CNY）', '3000.00', '6500.00', '7200.00', '2300.00'])}
      ${rows(['美元（USD）', '0.00', '0.00', '0.00', '0.00'])}
    </table>
    <table>
      ${rows(['账单周期Statement Cycle', '2026/07/15-2026/08/14', '本期到期还款日Payment Due Date', '2026/09/08'])}
      ${rows(['账户币种Currency', '本期全部应还款额New Balance', '最低还款额Min.Payment', '争议款/笔数Dispute Amt/Nbr'])}
      ${rows(['人民币（CNY）', '2300.00', '185.00', '-'])}
    </table>
    <table>
      ${rows(['【应还款明细】请按以下卡号、币种分别还款 ◇应还款额/溢缴款为负数，表示账户有溢缴款；金额前带-的交易表示还款交易、调整交易等。'])}
    </table>
    <table>
      ${rows(['信用卡卡号Card Number', '账户币种Currency', '应还款额/溢缴款New Balance', '最低还款额Min.Payment', '账户币种Currency', '应还款额/溢缴款New Balance', '最低还款额Min.Payment'])}
      ${rows(['622700******5678', '人民币(CNY)', '2300.00', '185.00', '', '', ''])}
    </table>
    <table>
      ${rows(['【交易明细】'])}
      ${rows(TXN_HEADER_CN)}
      ${rows(TXN_HEADER_EN)}
      ${rows(['[人民币账户] RMB Account', '上期账单余额(Previous Balance)', '3000.00'])}
      ${rows(['2026-07-17', '2026-07-17', '5678', '手机银行 按卡转账还款', 'CNY', '-3000.00', 'CNY', '-3000.00'])}
      ${rows(['2026-08-14', '2026-08-14', '5678', '退货 示例电商', 'CNY', '-2400.00', 'CNY', '-2400.00'])}
      ${rows(['2026-08-14', '2026-08-14', '5678', '退货 示例电商', 'CNY', '-1800.00', 'CNY', '-1800.00'])}
      ${rows(['2026-07-16', '2026-07-16', '5678', '商户分期-示例通讯-分3期', 'CNY', '900.00', 'CNY', '900.00'])}
      ${rows(['2026-07-16', '2026-07-16', '5678', '分期扣款 1/3期-商户分期-示例通讯', 'CNY', '300.00', 'CNY', '300.00'])}
      ${rows(['2026-07-20', '2026-07-20', '5678', '示例餐厅-消费测试店', 'CNY', '68.00', 'CNY', '68.00'])}
      ${rows(['2026-07-22', '2026-07-22', '5678', '示例商城', 'CNY', '1200.00', 'CNY', '1200.00'])}
      ${rows(['2026-07-25', '2026-07-25', '5678', '示例生鲜', 'CNY', '86.50', 'CNY', '86.50'])}
      ${rows(['2026-08-02', '2026-08-02', '5678', '示例电商有限公司', 'CNY', '2400.00', 'CNY', '2400.00'])}
      ${rows(['2026-08-02', '2026-08-02', '5678', '示例电商有限公司', 'CNY', '1800.00', 'CNY', '1800.00'])}
      ${rows(['2026-08-06', '2026-08-06', '5678', '示例出行', 'CNY', '34.20', 'CNY', '34.20'])}
      ${rows(['2026-08-09', '2026-08-09', '5678', '示例超市', 'CNY', '411.30', 'CNY', '411.30'])}
      ${rows(['2026-08-09', '2026-08-09', '5678', '示例超市', 'CNY', '100.00', 'CNY', '100.00'])}
      ${rows(['2026-08-09', '2026-08-09', '5678', '示例超市', 'CNY', '100.00', 'CNY', '100.00'])}
      ${rows(['*** 结束 The End ***'])}
    </table>
    <table>${rows(['★ 用卡小贴士 您可以通过中国建设银行手机银行ＡＰＰ便捷地查询电子账单。'])}</table>
  </body>
</html>
`

export const SYNTHETIC_CCB = {
  cardLast4: '5678',
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
  totalDebitRowsMinor: 740000,
}
