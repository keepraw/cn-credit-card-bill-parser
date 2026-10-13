"""Migration audit dry-run tests (Task A-4.1).

Pure-logic tests on synthetic rows: key building, exact/suspected/orphan
classification, float-dust snapping, and legacy type inference mirrors.
No fixtures, no database, no migration performed.
"""

from __future__ import annotations

import sys
from datetime import date, datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "src"))

import migration_audit as m
from ccparser.golden import normalize_description


def make_row(**overrides):
    base = {
        "bank": "icbc",
        "cardLast4": "3443",
        "transactionDate": "2026-07-16",
        "postingDate": "2026-07-16",
        "settlementAmountMinor": 30000,
        "currency": "CNY",
        "direction": "debit",
        "description": "消费 支付宝-示例餐厅",
        "normalizedDescription": normalize_description("消费 支付宝-示例餐厅"),
        "legacyType": "purchase",
        "sourceRow": 2,
    }
    base.update(overrides)
    return base


def test_business_key_stable():
    assert m.business_key(make_row()) == m.business_key(make_row())
    assert m.business_key(make_row(settlementAmountMinor=1)) != m.business_key(make_row())


def test_match_exact():
    report = m.match_rows([make_row()], [make_row()])
    assert (report["exact"], report["suspected"], report["orphan"]) == (1, 0, 0)


def test_match_suspected_on_description_drift():
    golden = make_row()
    legacy = make_row(description="消费 银联-另一家店")
    legacy["normalizedDescription"] = normalize_description(legacy["description"])
    report = m.match_rows([legacy], [golden])
    assert (report["exact"], report["suspected"], report["orphan"]) == (0, 1, 0)


def test_match_orphan():
    report = m.match_rows([make_row(transactionDate="2020-01-01")], [make_row()])
    assert (report["exact"], report["suspected"], report["orphan"]) == (0, 0, 1)


def test_self_collisions_counts_occurrences():
    report = m.self_collisions([make_row(), make_row(), make_row(transactionDate="2020-01-01")])
    assert report["exactDuplicateRows"] == 1
    assert report["rows"] == 3


def test_snap_float_dust():
    assert m.snap_float_to_minor(11.120000000000001, "CNY") == 1112
    assert m.snap_float_to_minor(10.005, "CNY") is None
    assert m.snap_float_to_minor(-3619.9, "CNY") == -361990


def test_str_to_minor():
    assert m.str_to_minor("2,395.48", "CNY") == 239548
    assert m.str_to_minor("CNY -3619.90", "CNY") == -361990
    assert m.str_to_minor("not-an-amount", "CNY") is None


def test_iso_of_datetime_and_serial():
    assert m.iso_of(datetime(2026, 5, 17, 12, 0)) == "2026-05-17"
    assert m.iso_of(date(2026, 5, 17)) == "2026-05-17"
    assert m.iso_of(45812) == "2025-06-04"
    assert m.iso_of("2026/05/17") == "2026-05-17"
    assert m.iso_of("2026-05-17") == "2026-05-17"
    assert m.iso_of(None) is None


def test_legacy_type_mirrors_adapter():
    assert m.infer_legacy_type("消费 支付宝-示例餐厅", "debit") == "purchase"
    assert m.infer_legacy_type("1/3期-商户分期-示例通讯", "debit") == "purchase"
    assert m.infer_legacy_type("分期扣款 1/3期-商户分期", "debit") == "installment_payment"
    assert m.infer_legacy_type("手机银行还款转入", "credit") == "payment"
    assert m.infer_native_type("分期扣款", "1/3期-商户分期-示例通讯", "debit") == "installment_payment"
    assert m.infer_native_type("刷卡金", "美食天天乐-示例商户", "credit") == "cashback"
