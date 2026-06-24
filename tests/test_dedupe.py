from datetime import date
from decimal import Decimal
from pathlib import Path

from ccparser.dedupe import assign_ids, statement_key, transaction_id
from ccparser.models import ParsedStatement, Transaction


def make_transaction(description: str = "消费 星巴克") -> Transaction:
    return Transaction(
        bank="交通银行",
        card_last4="1234",
        transaction_date=date(2025, 12, 18),
        posting_date=date(2025, 12, 19),
        description=description,
        transaction_currency="CNY",
        transaction_amount=Decimal("35.50"),
        settlement_currency="CNY",
        settlement_amount=Decimal("35.50"),
        source_file_name="sample.html",
        source_file_hash="abc",
        confidence=0.9,
        raw_text="raw",
    )


def test_statement_key_stable():
    first = statement_key("交通银行", "1234", date(2025, 12, 1), date(2025, 12, 31))
    second = statement_key("交通银行", "1234", date(2025, 12, 1), date(2025, 12, 31))
    assert first == second


def test_transaction_id_duplicate():
    assert transaction_id(make_transaction()) == transaction_id(make_transaction())


def test_transaction_id_changes_with_description():
    assert transaction_id(make_transaction("消费 A")) != transaction_id(make_transaction("消费 B"))


def test_assign_ids():
    statement = ParsedStatement(
        bank="交通银行",
        card_last4="1234",
        statement_start=date(2025, 12, 1),
        statement_end=date(2025, 12, 31),
        transactions=[make_transaction()],
        confidence=0.9,
        parser_name="test",
    )
    key = assign_ids(statement)
    assert statement.transactions[0].statement_key == key
    assert statement.transactions[0].transaction_id


def test_assign_ids_keeps_repeated_real_transactions():
    first = make_transaction()
    second = make_transaction()
    statement = ParsedStatement(
        bank="交通银行",
        card_last4="1234",
        statement_start=date(2025, 12, 1),
        statement_end=date(2025, 12, 31),
        transactions=[first, second],
        confidence=0.9,
        parser_name="test",
    )
    assign_ids(statement)
    assert first.transaction_id
    assert second.transaction_id
    assert first.transaction_id != second.transaction_id
