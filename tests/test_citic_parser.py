from pathlib import Path

from ccparser.models import SourceContext
from ccparser.parsers.citic import parse


def test_citic_email_pipe_transaction_parser():
    text = """
感谢您使用中信银行信用卡， 2026年06月 账单已产生，记录了您 2026年05月15日 至 2026年06月14日 账户变动信息。
卡号 3780-09**-****-650
【本期账务明细】
20260515 | 20260515 | 7650 |  | 支付宝还款 | CNY -3619.90 | CNY -3619.90
20260524 | 20260524 | 7650 |  | 财付通－CHAGEE霸王茶姬 | CNY 8.40 | CNY 8.40
20260614 | 20260614 | 7650 |  | 精彩笔笔返-0.01元支付券 | CNY -0.01 | CNY -0.01
"""
    context = SourceContext(
        path=Path("citic.eml"),
        file_name="citic.eml",
        file_hash="abc",
        source_type="email_html",
        text=text,
    )
    statement = parse(context)
    assert statement.bank == "中信银行"
    assert statement.card_last4 == "7650"
    assert statement.statement_start.isoformat() == "2026-05-15"
    assert statement.statement_end.isoformat() == "2026-06-14"
    assert len(statement.transactions) == 3
    assert statement.transactions[0].settlement_amount < 0
    assert statement.transactions[1].settlement_amount > 0
    assert statement.transactions[2].transaction_currency == "CNY"
