"""SQLite historical audit tests (one-off tool).

All fixtures are synthetic and live under tmp_path: a synthetic SQLite file
with the legacy transactions schema plus synthetic version-1 JSON backups.
The real data/statements.db is never touched.
"""

from __future__ import annotations

import importlib.util
import json
import sqlite3
import sys
from pathlib import Path

import pytest

SCRIPTS_DIR = Path(__file__).resolve().parent.parent / "scripts"


def load_audit_module():
    spec = importlib.util.spec_from_file_location(
        "sqlite_historical_audit", SCRIPTS_DIR / "sqlite_historical_audit.py"
    )
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    sys.modules["sqlite_historical_audit"] = module
    spec.loader.exec_module(module)
    return module


audit = load_audit_module()

TX_COLUMNS = (
    "transaction_id", "statement_key", "bank", "card_last4",
    "transaction_date", "posting_date", "description",
    "transaction_currency", "transaction_amount",
    "settlement_currency", "settlement_amount",
    "source_file_name", "source_file_hash", "confidence", "raw_text",
)


def make_sqlite_db(path: Path, rows: list[tuple]) -> Path:
    conn = sqlite3.connect(path)
    conn.execute(
        """CREATE TABLE transactions (
            transaction_id TEXT PRIMARY KEY, statement_key TEXT NOT NULL,
            bank TEXT NOT NULL, card_last4 TEXT NOT NULL,
            transaction_date TEXT NOT NULL, posting_date TEXT NOT NULL,
            description TEXT NOT NULL, transaction_currency TEXT NOT NULL,
            transaction_amount TEXT NOT NULL, settlement_currency TEXT NOT NULL,
            settlement_amount TEXT NOT NULL, source_file_name TEXT NOT NULL,
            source_file_hash TEXT NOT NULL, confidence REAL NOT NULL,
            raw_text TEXT NOT NULL)"""
    )
    conn.execute(
        "CREATE TABLE statements (statement_key TEXT PRIMARY KEY, bank TEXT NOT NULL,"
        " card_last4 TEXT NOT NULL, statement_start TEXT, statement_end TEXT)"
    )
    for row in rows:
        conn.execute(f"INSERT INTO transactions ({', '.join(TX_COLUMNS)}) VALUES ({', '.join('?' * len(TX_COLUMNS))})", row)
    conn.commit()
    conn.close()
    return path


def sqlite_row(tx_id="s-tx-1", desc="消费 合成咖啡", txn_amt="128.80", stl_amt="128.80",
               txn_ccy="CNY", stl_ccy="CNY", txn_date="2024-01-05", post_date="2024-01-06",
               bank="中国银行", card="1234"):
    return (tx_id, "s-key-1", bank, card, txn_date, post_date, desc, txn_ccy, txn_amt,
            stl_ccy, stl_amt, "synthetic.eml", "hash-sqlite", 0.95, desc)


def make_backup(path: Path, transactions: list[dict]) -> Path:
    payload = {
        "format": "credit-card-data-backup", "version": 1,
        "exportedAt": "2024-02-01T00:00:00.000Z",
        "statements": [{
            "id": "synthetic-stmt-1", "statementKey": "key-1", "bank": "boc",
            "cardLast4": "1234", "cycleStart": "2024-01-01", "cycleEnd": "2024-01-31",
            "dueDate": None,
            "summary": {"previousBalanceMinor": None, "newDebitMinor": None,
                        "newCreditMinor": None, "chargeMinor": None, "interestMinor": None,
                        "currentBalanceMinor": None, "minimumPaymentMinor": None,
                        "creditLimitMinor": None, "dueDate": None, "components": []},
            "reconciliation": {"status": "passed", "checks": [], "computedBalanceMinor": 0},
            "status": "reconciled", "parserId": "synthetic", "parserVersion": "1",
            "transactionCount": len(transactions), "sourceFileName": "synthetic.eml",
            "sourceFileHash": "hash-ts", "importedAt": "2024-02-01T00:00:00.000Z", "isDemo": False,
        }],
        "transactions": transactions, "imports": [], "settings": None,
    }
    path.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
    return path


def ts_tx(tx_id="s-tx-1", desc="消费 合成咖啡", txn_minor=12880, stl_minor=12880,
          txn_ccy="CNY", stl_ccy="CNY", txn_date="2024-01-05", post_date="2024-01-06",
          tx_type="purchase", direction="debit"):
    return {
        "id": tx_id, "statementId": "synthetic-stmt-1", "bank": "boc", "cardLast4": "1234",
        "transactionDate": txn_date, "postingDate": post_date, "description": desc,
        "rawDescription": desc, "merchant": "合成", "transactionCurrency": txn_ccy,
        "transactionAmountMinor": txn_minor, "settlementCurrency": stl_ccy,
        "settlementAmountMinor": stl_minor, "type": tx_type, "direction": direction,
        "category": "未分类", "confidence": 1.0, "flags": [], "reviewStatus": "ok",
        "sourceFileName": "synthetic.eml", "sourceFileHash": "hash-ts",
        "sourcePage": None, "sourceRow": 1, "rawText": desc,
        "fingerprint": "fp-" + tx_id, "occurrence": 1, "isDemo": False,
    }


def run(db: Path, backups: list[Path], tmp_path: Path):
    return audit.run_audit(db, backups, tmp_path / "golden-missing", tmp_path / "output-missing")


def test_missing_db_and_no_backups_is_safe(tmp_path):
    report, required = run(tmp_path / "no-such.db", [], tmp_path)
    assert required is False
    for expected in ("SQLite transactions:\n0", "TypeScript transactions:\n0",
                     "Migration required:\nNO", "Python removal:\nSAFE"):
        assert expected in report


def test_matching_sets_including_multi_currency_negative_and_duplicates(tmp_path):
    db = make_sqlite_db(tmp_path / "s.db", [
        sqlite_row("s-cny", "消费 合成咖啡"),
        sqlite_row("s-usd", "消费 合成书店", "18.00", "129.60", "USD", "CNY",
                   "2024-01-07", "2024-01-08"),
        sqlite_row("s-jpy", "消费 合成文具", "1200", "10.05", "JPY", "USD",
                   "2024-01-09", "2024-01-10"),
        sqlite_row("s-dup-1", "消费 合成超市", "50.00", "50.00",
                   "CNY", "CNY", "2024-02-07", "2024-02-08"),
        sqlite_row("s-dup-2", "消费 合成超市", "50.00", "50.00",
                   "CNY", "CNY", "2024-02-07", "2024-02-08"),
        sqlite_row("s-refund", "退货 合成商城", "-25.00", "-180.00", "EUR", "CNY",
                   "2024-02-09", "2024-02-10"),
    ])
    backup = make_backup(tmp_path / "b.json", [
        ts_tx("t-cny", "消费 合成咖啡"),
        ts_tx("t-usd", "消费 合成书店", 1800, 12960, "USD", "CNY", "2024-01-07", "2024-01-08"),
        ts_tx("t-jpy", "消费 合成文具", 1200, 1005, "JPY", "USD", "2024-01-09", "2024-01-10"),
        ts_tx("t-dup-1", "消费 合成超市", 5000, 5000, "CNY", "CNY", "2024-02-07", "2024-02-08"),
        ts_tx("t-dup-2", "消费 合成超市", 5000, 5000, "CNY", "CNY", "2024-02-07", "2024-02-08"),
        ts_tx("t-refund", "退货 合成商城", -2500, -18000, "EUR", "CNY",
              "2024-02-09", "2024-02-10", "refund", "credit"),
    ])
    report, required = run(db, [backup], tmp_path)
    assert required is False
    assert "SQLite only transactions:\n0" in report
    assert "TypeScript only transactions:\n0" in report
    assert "Field mismatches:\n0" in report
    assert "Duplicate relationship mismatches:\n0" in report
    assert "Python removal:\nSAFE" in report


def test_sqlite_only_row_requires_migration(tmp_path):
    db = make_sqlite_db(tmp_path / "s.db", [
        sqlite_row("s-keep", "消费 合成咖啡"),
        sqlite_row("s-missing", "消费 合成面包房"),
    ])
    backup = make_backup(tmp_path / "b.json", [ts_tx("t-keep", "消费 合成咖啡")])
    report, required = run(db, [backup], tmp_path)
    assert required is True
    assert "SQLite only transactions:\n1" in report
    assert "Migration required:\nYES" in report
    assert "Python removal:\nNOT SAFE" in report


def test_typescript_only_row_requires_migration(tmp_path):
    db = make_sqlite_db(tmp_path / "s.db", [sqlite_row("s-keep", "消费 合成咖啡")])
    backup = make_backup(tmp_path / "b.json", [
        ts_tx("t-keep", "消费 合成咖啡"),
        ts_tx("t-extra", "消费 合成 extra 商店"),
    ])
    report, required = run(db, [backup], tmp_path)
    assert required is True
    assert "TypeScript only transactions:\n1" in report


def test_posting_date_drift_is_field_mismatch_not_missing(tmp_path):
    db = make_sqlite_db(tmp_path / "s.db", [sqlite_row("s-1", "消费 合成咖啡")])
    backup = make_backup(tmp_path / "b.json", [
        ts_tx("t-1", "消费 合成咖啡", 12880, 12880, "CNY", "CNY", "2024-01-05", "2024-01-07"),
    ])
    report, required = run(db, [backup], tmp_path)
    assert required is True
    assert "SQLite only transactions:\n0" in report
    assert "TypeScript only transactions:\n0" in report
    assert "Field mismatches:\n1" in report
    assert "Duplicate relationship mismatches:\n0" in report


def test_settlement_amount_drift_is_missing_not_field_mismatch(tmp_path):
    # Money is identity: different settlement amounts are different canonical
    # rows, reported as missing/extra for manual review (never force-paired).
    db = make_sqlite_db(tmp_path / "s.db", [sqlite_row("s-1", "消费 合成咖啡", "128.80", "128.80")])
    backup = make_backup(tmp_path / "b.json", [ts_tx("t-1", "消费 合成咖啡", 12880, 12900)])
    report, required = run(db, [backup], tmp_path)
    assert required is True
    assert "SQLite only transactions:\n1" in report
    assert "TypeScript only transactions:\n1" in report
    assert "Field mismatches:\n0" in report


def test_duplicate_occurrence_drift_is_reported(tmp_path):
    db = make_sqlite_db(tmp_path / "s.db", [
        sqlite_row("s-dup-1", "消费 合成超市", "50.00", "50.00", "CNY", "CNY", "2024-02-07", "2024-02-08"),
        sqlite_row("s-dup-2", "消费 合成超市", "50.00", "50.00", "CNY", "CNY", "2024-02-07", "2024-02-08"),
    ])
    backup = make_backup(tmp_path / "b.json", [
        ts_tx("t-dup-1", "消费 合成超市", 5000, 5000, "CNY", "CNY", "2024-02-07", "2024-02-08"),
    ])
    report, required = run(db, [backup], tmp_path)
    assert required is True
    assert "Duplicate relationship mismatches:\n1" in report


def test_invalid_backup_fails_closed(tmp_path):
    db = make_sqlite_db(tmp_path / "s.db", [sqlite_row()])
    bad = tmp_path / "bad.json"
    bad.write_text(json.dumps({"format": "something-else"}), encoding="utf-8")
    with pytest.raises(audit.AuditError):
        audit.load_ts([bad])


def test_guard_rejects_writes(tmp_path):
    db = make_sqlite_db(tmp_path / "s.db", [sqlite_row()])
    conn = audit.ro_connect(db)
    try:
        with pytest.raises(audit.AuditError):
            audit.guarded_execute(conn, "DELETE FROM transactions")
        with pytest.raises(audit.AuditError):
            audit.guarded_execute(conn, "VACUUM")
        assert audit.guarded_execute(conn, "SELECT COUNT(*) FROM transactions").fetchone()[0] == 1
    finally:
        conn.close()
