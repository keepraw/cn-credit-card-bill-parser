"""Golden infrastructure tests (Task A-3.4).

Verifies the comparison machinery only: schema stability, diff severity rules,
identity observation (no merging), and desensitization determinism.

Does NOT assert post-fix parser results or new business rules.
"""

from __future__ import annotations

import json
from datetime import date
from decimal import Decimal
from pathlib import Path

from ccparser.golden import (
    GOLDEN_SCHEMA,
    P0_FIELDS,
    build_identity_table,
    business_key,
    decimal_to_minor,
    desensitize_description,
    desensitize_raw_text,
    diff_normalized,
    fnv1a32,
    normalize_description,
    normalize_python_statement,
    normalize_python_transaction,
)
from ccparser.models import ParsedStatement, Transaction

GOLDEN_ROOT = Path(__file__).resolve().parent.parent / "golden"


def make_tx(**overrides):
    fields = {
        "bank": "工商银行",
        "card_last4": "3443",
        "transaction_date": date(2026, 5, 23),
        "posting_date": date(2026, 5, 23),
        "description": "消费 test-shop",
        "transaction_currency": "CNY",
        "transaction_amount": Decimal("13.82"),
        "settlement_currency": "CNY",
        "settlement_amount": Decimal("13.82"),
        "source_file_name": "test.eml",
        "source_file_hash": "hash",
        "confidence": 0.96,
        "raw_text": "3443 | 2026-05-23 | 消费 test-shop | 13.82/RMB",
        "transaction_id": "tid-1",
        "statement_key": "skey-1",
    }
    fields.update(overrides)
    return Transaction(**fields)


def make_doc(tx_dict):
    return {"schema": GOLDEN_SCHEMA, "transactions": [tx_dict]}


def norm_dict(tx):
    return normalize_python_transaction(tx, seq=0, desensitize=False).to_dict()


def test_fnv1a32_known_vector():
    # Shared cross-language vector (mirrored in web/tests/golden.test.ts).
    assert fnv1a32("hello") == "4f9f2cab"


def test_decimal_to_minor_exact():
    assert decimal_to_minor(Decimal("2100.00"), "CNY") == 210000
    assert decimal_to_minor(Decimal("-3619.90"), "CNY") == -361990
    assert decimal_to_minor(Decimal("100"), "JPY") == 100


def test_normalized_schema_stable_p0_fields():
    tx = make_tx()
    normalized = normalize_python_transaction(tx, seq=3, desensitize=False)
    row = normalized.to_dict()
    for field_name in P0_FIELDS:
        assert field_name in row, f"missing P0 field {field_name}"
    assert row["bank"] == "icbc"
    assert row["cardLast4"] == "3443"
    assert row["transactionDate"] == "2026-05-23"
    assert row["postingDate"] == "2026-05-23"
    assert row["amountMinor"] == 1382
    assert isinstance(row["amountMinor"], int)
    assert row["currency"] == "CNY"
    assert row["direction"] == "debit"
    assert row["nativeId"] == "tid-1"
    assert row["statementKey"] == "skey-1"
    assert row["sourcePosition"] == {"row": 3}


def test_direction_from_settlement_sign():
    assert normalize_python_transaction(make_tx(settlement_amount=Decimal("-5.00")), seq=0, desensitize=False).direction == "credit"
    assert normalize_python_transaction(make_tx(settlement_amount=Decimal("5.00")), seq=0, desensitize=False).direction == "debit"


def test_diff_identical_is_pass():
    report = diff_normalized(make_doc(norm_dict(make_tx())), make_doc(norm_dict(make_tx())))
    assert report["verdict"] == "PASS"
    assert report["findings"] == []
    assert report["pairedRows"] == 1


def test_diff_amount_mismatch_is_blocking():
    python = make_doc(norm_dict(make_tx()))
    web = make_doc(norm_dict(make_tx()))
    web["transactions"][0]["amountMinor"] = 1383
    # A changed amount changes the business key -> unpaired rows.
    report = diff_normalized(python, web)
    assert report["verdict"] == "BLOCKING"
    assert any(f["severity"] == "BLOCKING" and f["rule"] == "transaction_count" for f in report["findings"])


def test_diff_direction_mismatch_is_blocking():
    # Same business key but conflicting direction (rule-level guard).
    python = make_doc(norm_dict(make_tx()))
    web = make_doc(norm_dict(make_tx()))
    web["transactions"][0]["direction"] = "credit"
    report = diff_normalized(python, web)
    assert report["verdict"] == "BLOCKING"
    assert any(f["severity"] == "BLOCKING" and f["rule"] == "direction" for f in report["findings"])


def test_diff_scope_mismatch_is_blocking():
    # Same dates/amount/currency on a different card (multi-card statements).
    python = make_doc(norm_dict(make_tx()))
    web = make_doc(norm_dict(make_tx()))
    web["transactions"][0]["cardLast4"] = "9999"
    report = diff_normalized(python, web)
    assert report["verdict"] == "BLOCKING"
    assert any(f["severity"] == "BLOCKING" and f["rule"] == "identity_scope" for f in report["findings"])


def test_diff_date_mismatch_is_blocking():
    python = make_doc(norm_dict(make_tx()))
    web = make_doc(norm_dict(make_tx()))
    web["transactions"][0]["postingDate"] = "2026-05-24"
    # Different posting date changes the business key -> unpaired rows.
    report = diff_normalized(python, web)
    assert report["verdict"] == "BLOCKING"
    assert any(f["severity"] == "BLOCKING" and f["rule"] == "transaction_count" for f in report["findings"])


def test_diff_count_mismatch_is_blocking():
    python = {"schema": GOLDEN_SCHEMA, "transactions": [norm_dict(make_tx()), norm_dict(make_tx())]}
    web = make_doc(norm_dict(make_tx()))
    report = diff_normalized(python, web)
    assert report["verdict"] == "BLOCKING"
    assert any(f["rule"] == "transaction_count" for f in report["findings"])


def test_diff_description_only_is_warning():
    python = make_doc(norm_dict(make_tx()))
    web = make_doc(norm_dict(make_tx()))
    web["transactions"][0]["description"] = "消费 test-shop-b"
    web["transactions"][0]["normalizedDescription"] = normalize_description("消费 test-shop-b")
    assert web["transactions"][0]["normalizedDescription"] != python["transactions"][0]["normalizedDescription"]
    report = diff_normalized(python, web)
    assert report["verdict"] == "WARNING"
    assert all(f["severity"] == "WARNING" for f in report["findings"])
    assert any(f["rule"] == "description" for f in report["findings"])


def test_diff_rawtext_only_is_silent():
    python = make_doc(norm_dict(make_tx()))
    web = make_doc(norm_dict(make_tx()))
    web["transactions"][0]["rawText"] = "different debug text"
    report = diff_normalized(python, web)
    assert report["verdict"] == "PASS"


def test_identity_report_never_merges():
    python = {"schema": GOLDEN_SCHEMA, "transactions": [norm_dict(make_tx()), norm_dict(make_tx())]}
    web = make_doc(norm_dict(make_tx()))
    report = diff_normalized(python, web)
    identity = report["identity"]
    assert identity["compatible"] is False
    assert identity["merged"] is False
    assert identity["entries"]
    assert all(entry["merged"] is False for entry in identity["entries"])
    # One paired + one unpaired entry; business keys observable on both sides.
    assert {e["match"] for e in identity["entries"]} == {"full", "unpaired"}
    assert all(e["businessKey"] == business_key(python["transactions"][0]) for e in identity["entries"])


def test_build_identity_table_shape_direct():
    table = build_identity_table([], [], [], [], [])
    assert table["merged"] is False
    assert table["entries"] == []


def test_desensitize_deterministic_and_structure_preserving():
    first = desensitize_description("网上消费 财付通，京东商城平台商户")
    second = desensitize_description("网上消费 财付通，京东商城平台商户")
    assert first == second
    assert first.startswith("网上消费 商户_")
    other = desensitize_description("网上消费 另一家完全不同的店铺名称")
    assert other.startswith("网上消费 商户_") and other != first
    bare = desensitize_description("还款")
    assert bare == "还款"
    masked = desensitize_raw_text("3443 | 2026-05-23 | 消费 财付通京东商城 | 13.82/RMB(支出)")
    assert "13.82" in masked and "2026-05-23" in masked
    assert "财付通京东商城" not in masked
    latin = desensitize_raw_text("5155 | 消费 FILA旗舰店-SHARESIES LTD SYDNEY | CNY 1672.90")
    assert "FILA" not in latin and "SHARESIES" not in latin and "SYDNEY" not in latin
    assert "CNY" in latin and "1672.90" in latin


def test_normalize_statement_shape():
    statement = ParsedStatement(
        bank="工商银行",
        card_last4="3443",
        statement_start=date(2026, 5, 23),
        statement_end=date(2026, 6, 22),
        transactions=[make_tx()],
        confidence=0.95,
        parser_name="icbc_email",
    )
    doc = normalize_python_statement(statement, desensitize=True)
    assert doc["schema"] == GOLDEN_SCHEMA
    assert doc["origin"] == "python"
    assert doc["bank"] == "icbc"
    assert doc["transactionCount"] == 1
    assert doc["desensitized"] is True


BATCH_ONE = ["icbc", "abc", "ccb"]
BATCH_TWO = ["boc", "bocom", "citic"]


def test_committed_batch_one_fixtures_conform():
    _assert_fixtures_conform(BATCH_ONE)


def test_committed_batch_two_fixtures_conform():
    _assert_fixtures_conform(BATCH_TWO)


def _assert_fixtures_conform(banks):
    for bank in banks:
        bank_dir = GOLDEN_ROOT / bank
        assert bank_dir.is_dir(), f"missing golden/{bank}"
        stmt_dirs = [p for p in bank_dir.iterdir() if p.is_dir()]
        assert stmt_dirs, f"no statement dir in golden/{bank}"
        for stmt_dir in stmt_dirs:
            for name in ("input.meta.json", "python.json", "web.json", "diff.json"):
                assert (stmt_dir / name).is_file(), f"missing {stmt_dir.name}/{name}"
            python_doc = json.loads((stmt_dir / "python.json").read_text(encoding="utf-8"))
            assert python_doc["schema"] == GOLDEN_SCHEMA
            assert python_doc["desensitized"] is True
            assert python_doc["bank"] == bank
            for tx in python_doc["transactions"]:
                for field_name in P0_FIELDS:
                    assert tx[field_name] not in (None, ""), f"{stmt_dir.name}: empty P0 {field_name}"
                assert isinstance(tx["amountMinor"], int)
            meta = json.loads((stmt_dir / "input.meta.json").read_text(encoding="utf-8"))
            assert len(meta["sha256"]) == 64
