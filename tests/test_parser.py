from pathlib import Path

from ccparser.extractors import extract_source
from ccparser.parsers.registry import parse_statement


def test_parse_sample_html():
    source = extract_source(Path("samples/sample_bocom_email.html"))
    statement = parse_statement(source)
    assert statement.bank == "交通银行"
    assert statement.card_last4 == "1234"
    assert statement.statement_start.isoformat() == "2025-12-01"
    assert statement.statement_end.isoformat() == "2025-12-31"
    assert len(statement.transactions) == 3
    assert statement.transactions[0].settlement_amount > 0
    assert statement.transactions[1].settlement_amount < 0
