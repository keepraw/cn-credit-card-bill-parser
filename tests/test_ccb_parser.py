from pathlib import Path

from ccparser.models import SourceContext
from ccparser.parsers.ccb import parse


def test_ccb_email_signed_amounts():
    text = """
感谢使用中国建设银行龙卡信用卡，以下为您 2026年03月23日 至2026年04月22日 信用卡账户变动情况
账单周期 Statement Cycle | 2026/03/23-2026/04/22
37051260***5574 | 人民币(CNY) | 2,282.54 | 200.00
【交易明细】
交易日 | 银行记账日 | 卡号后四位 | 交易描述 | 交易币/金额 | 结算币/金额
2026-03-23 | 2026-03-23 | 5574 | 手机银行 按卡转账还款 张鸿川 | CNY | -2,395.48 | CNY | -2,395.48
2026-04-01 | 2026-04-01 | 5574 | 财付通-微信支付-携程旅行网 | CNY | 348.00 | CNY | 348.00
2026-04-01 | 2026-04-01 | 5574 | 财付通-财付通-携程旅行网 | CNY | -280.74 | CNY | -280.74
*** 结束 The End ***
"""
    context = SourceContext(
        path=Path("ccb.eml"),
        file_name="ccb.eml",
        file_hash="abc",
        source_type="email_html",
        text=text,
    )
    statement = parse(context)
    assert statement.bank == "建设银行"
    assert statement.card_last4 == "5574"
    assert statement.statement_start.isoformat() == "2026-03-23"
    assert statement.statement_end.isoformat() == "2026-04-22"
    assert len(statement.transactions) == 3
    assert statement.transactions[0].settlement_amount < 0
    assert statement.transactions[1].settlement_amount > 0
    assert statement.transactions[2].settlement_amount < 0
    assert statement.transactions[0].settlement_currency == "CNY"
