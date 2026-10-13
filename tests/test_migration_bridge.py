"""Migration bridge dry-run tests (Task A-4.2).

Pure matching-logic tests on synthetic rows: pythonId derivation matches
pipeline assignment, L1/L2/L3 levels classify correctly, occurrence twins
become SUSPECTED (never auto-merged), and the duplicate simulation counts
before/after without touching any database.
"""

from __future__ import annotations

import sys
from datetime import date
from decimal import Decimal
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "src"))

from ccparser.dedupe import assign_ids
from ccparser.migration_bridge import (
    MATCHED,
    ORPHAN,
    SUSPECTED,
    build_bridge,
    derive_python_id,
    duplicate_simulation,
    full_key,
)
from ccparser.models import ParsedStatement, Transaction


def make_tx(description="消费 支付宝-示例餐厅", amount=Decimal("13.82")):
    return Transaction(
        bank="工商银行", card_last4="3443",
        transaction_date=date(2026, 5, 23), posting_date=date(2026, 5, 23),
        description=description, transaction_currency="CNY",
        transaction_amount=amount, settlement_currency="CNY",
        settlement_amount=amount, source_file_name="t.eml",
        source_file_hash="h", confidence=0.96, raw_text="raw",
    )


def legacy_row(python_id="pid", **overrides):
    base = {
        "bank": "icbc", "cardLast4": "3443",
        "transactionDate": "2026-05-23", "postingDate": "2026-05-23",
        "settlementAmountMinor": 1382, "currency": "CNY",
        "normalizedDescription": "消费支付宝-示例餐厅",
        "pythonId": python_id, "sourceRow": 2, "edge": None,
    }
    base.update(overrides)
    return base


def test_derive_python_id_matches_pipeline_assignment():
    tx = make_tx()
    statement = ParsedStatement(
        bank="工商银行", card_last4="3443", statement_start=date(2026, 5, 1),
        statement_end=date(2026, 5, 31), transactions=[tx],
        confidence=0.9, parser_name="test",
    )
    assign_ids(statement)
    derived = derive_python_id("工商银行", "3443", "2026-05-23", "2026-05-23", 1382, tx.description)
    assert derived == tx.transaction_id
    assert len(derived) == 64


def test_level1_exact_single_web_candidate():
    legacy = [legacy_row()]
    fresh = [dict(legacy[0], goldenFile="g")]
    web_map = {"icbc|3443|2026-05-23|1382|CNY": ["fp-web"]}
    (candidate,) = build_bridge(legacy, fresh, web_map)
    assert candidate.matchType == MATCHED
    assert candidate.webId == "fp-web"
    assert candidate.confidence == 0.95
    assert candidate.reason == "exact_business_key"


def test_level2_multiple_web_candidates_never_merge():
    legacy = [legacy_row(), legacy_row(python_id="pid2")]
    fresh = [dict(legacy[0], goldenFile="g")]
    web_map = {"icbc|3443|2026-05-23|1382|CNY": ["fp-web", "fp-web#2"]}
    candidates = build_bridge(legacy, fresh, web_map)
    assert all(c.matchType == SUSPECTED for c in candidates)
    assert all(c.webId is None for c in candidates)
    assert all(c.candidateWebIds == ["fp-web", "fp-web#2"] for c in candidates)


def test_level2_description_drift():
    legacy = [legacy_row(normalizedDescription="消费银联-另一家店")]
    fresh = [legacy_row()]
    web_map = {"icbc|3443|2026-05-23|1382|CNY": ["fp-web"]}
    (candidate,) = build_bridge(legacy, fresh, web_map)
    assert candidate.matchType == SUSPECTED
    assert candidate.reason == "description_drift"
    assert candidate.candidateWebIds == ["fp-web"]


def test_level3_orphan():
    (candidate,) = build_bridge([legacy_row()], [], {})
    assert candidate.matchType == ORPHAN
    assert candidate.confidence == 0.0
    assert candidate.webId is None


def test_duplicate_simulation_before_after():
    candidates = build_bridge(
        [legacy_row(), legacy_row(python_id="p2"), legacy_row(python_id="p3", transactionDate="2020-01-01")],
        [legacy_row(), legacy_row(python_id="p2")],
        {"icbc|3443|2026-05-23|1382|CNY": ["fp-web"]},
    )
    simulation = duplicate_simulation(candidates)
    assert simulation["before"]["duplicatesWouldInsert"] == 2
    assert simulation["after"]["duplicatesWouldInsert"] == 0
    assert simulation["after"]["skippedByMapping"] == 2
    assert simulation["after"]["reviewQueue"] == 0
    assert simulation["orphanOutOfScope"] == 1
    assert simulation["merged"] is False


def test_full_key_uses_normalized_description():
    assert full_key(legacy_row()) == full_key(legacy_row(python_id="other"))
