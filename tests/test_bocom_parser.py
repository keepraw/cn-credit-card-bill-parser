from pathlib import Path

from ccparser.models import SourceContext
from ccparser.parsers.bocom import parse


def test_bocom_email_section_signs():
    text = """
交通银行个人信用卡 622252******5155 账单周期 Statement Cycle 2026/05/15-2026/06/14
还款、退货、费用返还明细
| 05/15 | 05/15 | 5155 | 信用卡还款 转账还款-银联 | CNY 6000.00 | CNY 6000.00
| 05/31 | 05/31 | 5155 | 退货 抖音支付-上海剪花餐饮管理有限公司 | CNY 19.79 | CNY 19.79
消费、取现、其他费用明细
| 05/17 | 05/17 | 5155 | 消费 支付宝-黄岛区小帅鑫玉生鲜店 | CNY 11.25 | CNY 11.25
| 06/03 | 06/03 | 5155 | 分期扣款 1/3期-商户分期 | CNY 172.66 | CNY 172.66
除以上账单显示交易外
"""
    context = SourceContext(
        path=Path("bocom.eml"),
        file_name="bocom.eml",
        file_hash="abc",
        source_type="email_html",
        text=text,
    )
    statement = parse(context)
    assert statement.bank == "交通银行"
    assert statement.card_last4 == "5155"
    assert statement.statement_start.isoformat() == "2026-05-15"
    assert statement.statement_end.isoformat() == "2026-06-14"
    assert len(statement.transactions) == 4
    assert statement.transactions[0].settlement_amount < 0
    assert statement.transactions[1].settlement_amount < 0
    assert statement.transactions[2].settlement_amount > 0
    assert statement.transactions[3].settlement_amount > 0
