from datetime import date
from decimal import Decimal

import pytest

from ccparser.db import Database
from ccparser.dedupe import assign_ids
from ccparser.exporters import export_outputs
from ccparser.models import ParsedStatement, Transaction


def make_statement() -> ParsedStatement:
    transaction = Transaction(
        bank="交通银行",
        card_last4="1234",
        transaction_date=date(2025, 12, 18),
        posting_date=date(2025, 12, 19),
        description="消费 星巴克",
        transaction_currency="CNY",
        transaction_amount=Decimal("35.50"),
        settlement_currency="CNY",
        settlement_amount=Decimal("35.50"),
        source_file_name="sample.html",
        source_file_hash="abc",
        confidence=0.9,
        raw_text="raw",
    )
    statement = ParsedStatement(
        bank="交通银行",
        card_last4="1234",
        statement_start=date(2025, 12, 1),
        statement_end=date(2025, 12, 31),
        transactions=[transaction],
        confidence=0.9,
        parser_name="test",
    )
    assign_ids(statement)
    return statement


def test_database_transaction_rolls_back_failed_run(tmp_path):
    db = Database(tmp_path / "statements.db")
    statement = make_statement()
    transaction = statement.transactions[0]

    with pytest.raises(RuntimeError):
        with db.transaction():
            db.upsert_statement(statement, transaction.statement_key, "abc", "sample.html", "html")
            db.insert_transaction(transaction)
            db.mark_file_processed("abc", "sample.html", "html")
            raise RuntimeError("abort")

    assert db.fetch_transactions() == []
    assert not db.file_processed("abc")
    db.close()


def test_export_validation_failure_keeps_existing_outputs(tmp_path, monkeypatch):
    output_dir = tmp_path / "output"
    output_dir.mkdir()
    unified_path = output_dir / "unified_transactions.xlsx"
    review_path = output_dir / "review.xlsx"
    unified_path.write_bytes(b"old unified")
    review_path.write_bytes(b"old review")

    def fail_validation(*args, **kwargs):
        raise RuntimeError("forced validation failure")

    monkeypatch.setattr("ccparser.exporters._validate_workbook", fail_validation)

    with pytest.raises(RuntimeError, match="forced validation failure"):
        export_outputs(output_dir, [], [])

    assert unified_path.read_bytes() == b"old unified"
    assert review_path.read_bytes() == b"old review"
