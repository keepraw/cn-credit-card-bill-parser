from pathlib import Path

from ccparser.extractors import extract_source
from ccparser.parsers.registry import parse_statement


def test_parse_sample_html(tmp_path: Path):
    sample = tmp_path / "synthetic_bocom.html"
    sample.write_text("""
    <html><body>
    <table>
    <tr><td>交通银行个人信用卡 622252******1234 账单周期 Statement Cycle 2025/12/01-2025/12/31</td></tr>
    <tr><td>消费、取现、其他费用明细</td></tr>
    <tr><td>12/05</td><td>12/06</td><td>1234</td><td>消费 示例商户</td><td>CNY 128.80</td><td>CNY 128.80</td></tr>
    <tr><td>还款、退货、费用返还明细</td></tr>
    <tr><td>12/10</td><td>12/10</td><td>1234</td><td>还款 示例还款</td><td>CNY 100.00</td><td>CNY 100.00</td></tr>
    <tr><td>12/11</td><td>12/11</td><td>1234</td><td>退货 示例退款</td><td>CNY 10.00</td><td>CNY 10.00</td></tr>
    </table></body></html>
    """, encoding="utf-8")
    source = extract_source(sample)
    statement = parse_statement(source)
    assert statement.bank == "交通银行"
    assert statement.card_last4 == "1234"
    assert statement.statement_start.isoformat() == "2025-12-01"
    assert statement.statement_end.isoformat() == "2025-12-31"
    assert len(statement.transactions) == 3
    assert statement.transactions[0].settlement_amount > 0
    assert statement.transactions[1].settlement_amount < 0
