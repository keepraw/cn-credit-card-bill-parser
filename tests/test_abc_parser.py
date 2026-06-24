from pathlib import Path

from ccparser.models import SourceContext
from ccparser.parsers.abc import parse


def test_abc_email_signed_amounts_and_duplicate_like_rows():
    text = """
您的信用卡账户信息 Statement Information
卡号 Card No | 622836******3982
账单周期 Statement Cycle | 2026/05/17-2026/06/16
交易明细 |
交易日期 T Date | 入账日期 P Date | 卡号 后四位 Card No. | 交易描述 Description | 交易金额/币种 Tran Amt/Curr | 入账金额/币种 (支出为-) Sett Amt/Curr
| ● | 还款
260525 | 260525 | 3982 | 卡卡转账 张鸿川 | 9291.47/CNY | 9291.47/CNY
| ● | 消费
260601 | 260601 | 3982 | 网上消费 财付通，京东商城平台商户 | 2100.00/CNY | -2100.00/CNY
260601 | 260601 | 3982 | 网上消费 财付通，京东商城平台商户 | 2100.00/CNY | -2100.00/CNY
| ● | 退货
260603 | 260603 | 3982 | 网上消费退货 网银在线退款 | 100.00/CNY | 100.00/CNY
积分统计
"""
    context = SourceContext(
        path=Path("abc.eml"),
        file_name="abc.eml",
        file_hash="abc",
        source_type="email_html",
        text=text,
    )
    statement = parse(context)
    assert statement.bank == "农业银行"
    assert statement.card_last4 == "3982"
    assert statement.statement_start.isoformat() == "2026-05-17"
    assert statement.statement_end.isoformat() == "2026-06-16"
    assert len(statement.transactions) == 4
    assert statement.transactions[0].settlement_amount < 0
    assert statement.transactions[1].settlement_amount > 0
    assert statement.transactions[2].settlement_amount > 0
    assert statement.transactions[3].settlement_amount < 0
