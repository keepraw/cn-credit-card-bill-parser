from pathlib import Path

from ccparser.models import SourceContext
from ccparser.parsers.icbc import parse


def test_icbc_email_deposit_and_expenditure_signs():
    text = """
感谢您使用工商银行信用卡
账单周期 2026年05月23日—2026年06月22日
需 还 款 明 细
3443(牡丹贷记卡) | 人民币(本位币) | 5,277.69/RMB | 527.77/RMB | 78,000.00/RMB
人民币(本位币) 交 易 明 细
卡号后四位 | 交易日 | 记账日 | 交易类型 | 商户名称/城市 | 交易金额/币种 | 记账金额/币种
---主卡明细---
3443 | 2026-05-23 | 2026-05-23 | 消费 | 财付通-CHAGEE霸王茶姬 | 13.82/RMB | 13.82/RMB(支出)
3443 | 2026-05-25 | 2026-05-25 | 银联入账 | 银联转账（云闪付） | 2,106.82/RMB | 2,106.82/RMB(存入)
3443 | 2026-05-25 | 2026-05-25 | 刷卡金 | 刷卡金入账-美食5元刷卡金 | 5.00/RMB | 5.00/RMB(存入)
工 银i 豆 信 息
"""
    context = SourceContext(
        path=Path("icbc.eml"),
        file_name="icbc.eml",
        file_hash="abc",
        source_type="email_html",
        text=text,
    )
    statement = parse(context)
    assert statement.bank == "工商银行"
    assert statement.card_last4 == "3443"
    assert statement.statement_start.isoformat() == "2026-05-23"
    assert statement.statement_end.isoformat() == "2026-06-22"
    assert len(statement.transactions) == 3
    assert statement.transactions[0].settlement_amount > 0
    assert statement.transactions[1].settlement_amount < 0
    assert statement.transactions[2].settlement_amount < 0
    assert statement.transactions[0].settlement_currency == "CNY"
