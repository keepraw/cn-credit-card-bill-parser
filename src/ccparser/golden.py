"""Golden-fixture adapter layer (Task A-3.4).

Read-only with respect to parsers: this module only *converts* already-parsed
statements into the cross-language ``golden/v1`` comparison format, desensitizes
committable output, and compares normalized outputs.

It must never change parser behavior, identity algorithms, or business rules.
"""

from __future__ import annotations

import re
from dataclasses import asdict, dataclass, field
from datetime import date
from decimal import Decimal
from pathlib import Path
from typing import Any

GOLDEN_SCHEMA = "golden/v1"
GENERATOR = "ccparser-golden-py/1.0.0"

#: Python (Chinese) bank name -> Web BankId. Mirrors legacyPythonExportV1 BANK_MAP.
BANK_TO_ID = {
    "中国银行": "boc",
    "交通银行": "bocom",
    "工商银行": "icbc",
    "中国工商银行": "icbc",
    "农业银行": "abc",
    "中国农业银行": "abc",
    "建设银行": "ccb",
    "中国建设银行": "ccb",
    "中信银行": "citic",
    "未知银行": "unknown",
}

#: Minor-unit exponents. Mirrors web money.ts CURRENCY_EXPONENT (subset used here).
CURRENCY_EXPONENT = {"JPY": 0, "KRW": 0, "VND": 0}
DEFAULT_EXPONENT = 2

P0_FIELDS = ("bank", "cardLast4", "transactionDate", "postingDate", "amountMinor", "currency", "direction")
P1_FIELDS = ("description", "normalizedDescription")
DEBUG_FIELDS = ("rawText", "sourcePosition")


def currency_exponent(currency: str) -> int:
    return CURRENCY_EXPONENT.get((currency or "CNY").upper(), DEFAULT_EXPONENT)


def decimal_to_minor(amount: Decimal, currency: str = "CNY") -> int:
    """Major-unit Decimal -> integer minor units (no float math)."""
    exp = currency_exponent(currency)
    scaled = (Decimal(amount) * (10**exp)).to_integral_value()
    return int(scaled)


def fnv1a32(text: str) -> str:
    """32-bit FNV-1a hex. Shared with the TS adapter for stable placeholders.

    Known vector: fnv1a32("hello") == "4f9f2cab".
    """
    digest = 0x811C9DC5
    for byte in text.encode("utf-8"):
        digest ^= byte
        digest = (digest * 0x01000193) & 0xFFFFFFFF
    return f"{digest:08x}"


_VOLATILE_MARKERS = re.compile(r"\b(?:CHN|CR|DR|CNY|RMB|USD|HKD)\b", re.IGNORECASE)


def normalize_description(text: str) -> str:
    """Fingerprint-level normalization. Mirrors web identity.ts normalizeDescription."""
    value = _VOLATILE_MARKERS.sub("", text or "")
    value = re.sub(r"[（(].*?[）)]", "", value)
    value = re.sub(r"[\s ]+", "", value)
    value = re.sub(r"[-_·、,，.。/\\]+", "-", value)
    return value.strip("-").lower()


def direction_for_minor(minor: int) -> str:
    return "credit" if minor < 0 else "debit"


# ---------------------------------------------------------------------------
# Desensitization (structure-preserving, deterministic, cross-language stable)
# ---------------------------------------------------------------------------

#: Leading structural tokens kept verbatim; everything after them is hashed.
KNOWN_PREFIXES = (
    "网上消费退货",
    "网上消费",
    "手机银行",
    "按卡转账还款",
    "跨行二维码支付",
    "转账还款",
    "信用卡还款",
    "自助还款",
    "网上还款",
    "分期扣款",
    "分期利息",
    "分期手续费",
    "每期入账",
    "分期入账",
    "商户分期",
    "银联入账",
    "银联转账",
    "网银转账",
    "网银在线",
    "卡卡转账",
    "刷卡金",
    "预借现金",
    "消费",
    "取现",
    "还款",
    "退货",
    "退款",
    "退汇",
    "返现",
    "返还",
    "利息",
    "手续费",
    "年费",
    "服务费",
    "违约金",
    "调整",
    "冲正",
    "转账",
    "存入",
    "支出",
    "贷方",
    "借记",
    "贷记",
)

#: Structural CJK tokens kept verbatim inside rawText; other CJK runs are masked.
STRUCTURAL_KEYWORDS = (
    "中国农业银行",
    "中国建设银行",
    "中国工商银行",
    "中国银行",
    "交通银行",
    "中信银行",
    "农业银行",
    "建设银行",
    "工商银行",
    "信用卡",
    "电子账单",
    "电子对账单",
    "客户对账单",
    "账单周期",
    "交易明细",
    "交易日期",
    "入账日期",
    "银行记账日",
    "交易日",
    "记账日",
    "卡号后四位",
    "交易描述",
    "交易金额",
    "记账金额",
    "币种",
    "还款",
    "退货",
    "退款",
    "消费",
    "取现",
    "存入",
    "支出",
    "温馨提示",
    "积分统计",
    "刷卡金统计",
)

_CJK_RUN = re.compile(r"[一-鿿]{2,}")
_LONG_DIGITS = re.compile(r"\d{16,}")
_LATIN_RUN = re.compile(r"[A-Za-z]{3,}")
#: Latin tokens kept verbatim in debug rawText (currencies, bank ids, signs).
_LATIN_ALLOW = frozenset({
    "CNY", "RMB", "USD", "HKD", "CHN", "EUR", "JPY", "GBP", "AUD",
    "CAD", "SGD", "CHF", "CR", "DR",
    "BOC", "BOCOM", "ICBC", "CCB", "ABC", "CITIC",
})


def _split_prefix(description: str) -> tuple[str, str]:
    for prefix in KNOWN_PREFIXES:
        if description.startswith(prefix):
            return prefix, description[len(prefix):].strip()
    return "", description.strip()


def desensitize_description(description: str) -> str:
    """Keep structural prefix; hash the remainder so distinct merchants stay distinct."""
    text = (description or "").replace(" ", " ").strip().rstrip("/").strip()
    if not text:
        return text
    prefix, rest = _split_prefix(text)
    if not rest:
        return prefix
    key = re.sub(r"\s+", " ", rest).strip()
    placeholder = f"商户_{fnv1a32(key)}"
    return f"{prefix} {placeholder}".strip() if prefix else placeholder


def desensitize_raw_text(raw_text: str) -> str:
    """Mask non-structural CJK runs and long digit runs; keep layout/amounts/dates."""
    if not raw_text:
        return raw_text

    def mask_run(match: re.Match[str]) -> str:
        run = match.group(0)
        if any(keyword in run for keyword in STRUCTURAL_KEYWORDS):
            return run
        for prefix in KNOWN_PREFIXES:
            if run.startswith(prefix):
                rest = run[len(prefix):]
                return prefix + ("██" if rest else "")
        return "██"

    value = _CJK_RUN.sub(mask_run, raw_text)
    value = _LATIN_RUN.sub(lambda match: match.group(0) if match.group(0).upper() in _LATIN_ALLOW else "██", value)
    value = _LONG_DIGITS.sub("****************", value)
    return value


# ---------------------------------------------------------------------------
# Normalized schema
# ---------------------------------------------------------------------------


@dataclass
class NormalizedTransaction:
    bank: str
    cardLast4: str
    transactionDate: str
    postingDate: str
    amountMinor: int
    currency: str
    direction: str
    description: str
    normalizedDescription: str
    rawText: str = ""
    sourcePosition: dict[str, Any] = field(default_factory=dict)
    nativeId: str = ""
    statementKey: str = ""

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


def normalize_python_transaction(transaction: Any, *, seq: int, desensitize: bool = True) -> NormalizedTransaction:
    """Convert a Python Transaction (models.py) to golden/v1. Adapter only."""
    currency = (transaction.settlement_currency or "CNY").upper()
    # The golden amount leg is the settlement leg (matches both dedupe schemes).
    settle_minor = decimal_to_minor(transaction.settlement_amount, currency)
    direction = direction_for_minor(settle_minor)
    description = str(transaction.description or "")
    if desensitize:
        description = desensitize_description(description)
        raw_text = desensitize_raw_text(str(transaction.raw_text or ""))
    else:
        raw_text = str(transaction.raw_text or "")
    bank_id = BANK_TO_ID.get(str(transaction.bank), "unknown")
    tran_date = transaction.transaction_date
    post_date = transaction.posting_date
    return NormalizedTransaction(
        bank=bank_id,
        cardLast4=str(transaction.card_last4 or ""),
        transactionDate=tran_date.isoformat() if isinstance(tran_date, date) else str(tran_date or ""),
        postingDate=post_date.isoformat() if isinstance(post_date, date) else str(post_date or ""),
        amountMinor=settle_minor,
        currency=currency,
        direction=direction,
        description=description,
        normalizedDescription=normalize_description(description),
        rawText=raw_text,
        sourcePosition={"row": seq},
        nativeId=str(transaction.transaction_id or ""),
        statementKey=str(transaction.statement_key or ""),
    )


def normalize_python_statement(statement: Any, *, desensitize: bool = True) -> dict[str, Any]:
    transactions = [
        normalize_python_transaction(tx, seq=index, desensitize=desensitize).to_dict()
        for index, tx in enumerate(statement.transactions)
    ]
    return {
        "schema": GOLDEN_SCHEMA,
        "origin": "python",
        "generator": GENERATOR,
        "bank": BANK_TO_ID.get(str(statement.bank), "unknown"),
        "bankNative": str(statement.bank),
        "cardLast4": str(statement.card_last4 or ""),
        "cycleStart": statement.statement_start.isoformat() if statement.statement_start else None,
        "cycleEnd": statement.statement_end.isoformat() if statement.statement_end else None,
        "parserName": str(statement.parser_name or ""),
        "desensitized": desensitize,
        "nativeIds": {"transactionAlgo": "sha256-pipe", "occurrence": "sha256(base,occurrence)"},
        "transactionCount": len(transactions),
        "transactions": transactions,
    }


def build_input_meta(
    path: Path,
    *,
    file_hash: str,
    source_type: str,
    statement: Any,
    desensitized: bool = True,
) -> dict[str, Any]:
    """Traceable input reference. Never embeds statement content."""
    return {
        "schema": GOLDEN_SCHEMA,
        "fileName": path.name,
        "fileSize": path.stat().st_size,
        "sha256": file_hash,
        "sourceType": source_type,
        "bank": BANK_TO_ID.get(str(statement.bank), "unknown"),
        "bankNative": str(statement.bank),
        "cardLast4": str(statement.card_last4 or ""),
        "cycleStart": statement.statement_start.isoformat() if statement.statement_start else None,
        "cycleEnd": statement.statement_end.isoformat() if statement.statement_end else None,
        "transactionCount": len(statement.transactions),
        "parserName": str(statement.parser_name or ""),
        "desensitized": desensitized,
        "generator": GENERATOR,
        "note": "Raw bill content is never committed. Re-run scripts/generate_golden.py with the original file (matching sha256) to reproduce.",
    }


# ---------------------------------------------------------------------------
# Diff rules (canonical; mirrored in web/src/golden/diff.ts)
# ---------------------------------------------------------------------------

BLOCKING = "BLOCKING"
WARNING = "WARNING"
INFO = "INFO"


def business_key(tx: dict[str, Any]) -> str:
    return "|".join(
        str(tx.get(field, ""))
        for field in ("transactionDate", "postingDate", "amountMinor", "currency")
    )


def diff_normalized(python_doc: dict[str, Any], web_doc: dict[str, Any]) -> dict[str, Any]:
    """Compare two golden/v1 statements. Pure function; no merging performed."""
    python_txs = list(python_doc.get("transactions", []))
    web_txs = list(web_doc.get("transactions", []))

    # Stable multiset alignment on the business key (order-preserving within key).
    web_buckets: dict[str, list[int]] = {}
    for index, tx in enumerate(web_txs):
        web_buckets.setdefault(business_key(tx), []).append(index)
    used_web: set[int] = set()
    pairs: list[tuple[int, int]] = []
    python_unpaired: list[int] = []
    for p_index, p_tx in enumerate(python_txs):
        bucket = web_buckets.get(business_key(p_tx), [])
        match = next((i for i in bucket if i not in used_web), None)
        if match is None:
            python_unpaired.append(p_index)
        else:
            used_web.add(match)
            pairs.append((p_index, match))
    web_unpaired = [i for i in range(len(web_txs)) if i not in used_web]

    findings: list[dict[str, Any]] = []
    for p_index in python_unpaired:
        findings.append({
            "severity": BLOCKING,
            "rule": "transaction_count",
            "side": "python_only",
            "pythonIndex": p_index,
            "detail": f"Python row {p_index} has no Web counterpart (business key {business_key(python_txs[p_index])}).",
        })
    for w_index in web_unpaired:
        findings.append({
            "severity": BLOCKING,
            "rule": "transaction_count",
            "side": "web_only",
            "webIndex": w_index,
            "detail": f"Web row {w_index} has no Python counterpart (business key {business_key(web_txs[w_index])}).",
        })

    for p_index, w_index in pairs:
        p_tx, w_tx = python_txs[p_index], web_txs[w_index]
        for rule in ("amountMinor", "direction", "currency"):
            if p_tx.get(rule) != w_tx.get(rule):
                findings.append({
                    "severity": BLOCKING,
                    "rule": rule,
                    "pythonIndex": p_index,
                    "webIndex": w_index,
                    "python": p_tx.get(rule),
                    "web": w_tx.get(rule),
                })
        for date_field in ("transactionDate", "postingDate"):
            if p_tx.get(date_field) != w_tx.get(date_field):
                findings.append({
                    "severity": BLOCKING,
                    "rule": "date",
                    "field": date_field,
                    "pythonIndex": p_index,
                    "webIndex": w_index,
                    "python": p_tx.get(date_field),
                    "web": w_tx.get(date_field),
                })
        if p_tx.get("bank") != w_tx.get("bank") or p_tx.get("cardLast4") != w_tx.get("cardLast4"):
            findings.append({
                "severity": BLOCKING,
                "rule": "identity_scope",
                "pythonIndex": p_index,
                "webIndex": w_index,
                "python": {"bank": p_tx.get("bank"), "cardLast4": p_tx.get("cardLast4")},
                "web": {"bank": w_tx.get("bank"), "cardLast4": w_tx.get("cardLast4")},
            })
        if p_tx.get("normalizedDescription") != w_tx.get("normalizedDescription"):
            findings.append({
                "severity": WARNING,
                "rule": "description",
                "pythonIndex": p_index,
                "webIndex": w_index,
                "python": p_tx.get("description"),
                "web": w_tx.get("description"),
            })

    blocking = sum(1 for f in findings if f["severity"] == BLOCKING)
    warnings = sum(1 for f in findings if f["severity"] == WARNING)
    verdict = "BLOCKING" if blocking else ("WARNING" if warnings else "PASS")

    identity = build_identity_table(python_txs, web_txs, pairs, python_unpaired, web_unpaired)

    return {
        "schema": GOLDEN_SCHEMA,
        "generator": GENERATOR,
        "python": {"transactionCount": len(python_txs)},
        "web": {"transactionCount": len(web_txs)},
        "pairedRows": len(pairs),
        "verdict": verdict,
        "severityCounts": {"BLOCKING": blocking, "WARNING": warnings, "INFO": 0},
        "findings": findings,
        "identity": identity,
    }


def build_identity_table(
    python_txs: list[dict[str, Any]],
    web_txs: list[dict[str, Any]],
    pairs: list[tuple[int, int]],
    python_unpaired: list[int],
    web_unpaired: list[int],
) -> dict[str, Any]:
    """Observation-only identity mapping. Never merges anything (merged=false)."""
    entries: list[dict[str, Any]] = []
    for p_index, w_index in pairs:
        p_tx, w_tx = python_txs[p_index], web_txs[w_index]
        p0_equal = all(p_tx.get(f) == w_tx.get(f) for f in P0_FIELDS)
        entries.append({
            "businessKey": business_key(p_tx),
            "pythonNativeId": p_tx.get("nativeId"),
            "webNativeId": w_tx.get("nativeId"),
            "match": "full" if p0_equal else "partial",
            "merged": False,
        })
    for p_index in python_unpaired:
        entries.append({
            "businessKey": business_key(python_txs[p_index]),
            "pythonNativeId": python_txs[p_index].get("nativeId"),
            "webNativeId": None,
            "match": "unpaired",
            "merged": False,
        })
    for w_index in web_unpaired:
        entries.append({
            "businessKey": business_key(web_txs[w_index]),
            "pythonNativeId": None,
            "webNativeId": web_txs[w_index].get("nativeId"),
            "match": "unpaired",
            "merged": False,
        })
    return {
        "pythonAlgo": "sha256-pipe",
        "webAlgo": "fnv1a-dual-lane",
        "compatible": False,
        "note": "Identity schemes are incompatible by design (A-3.2 section 5). This table only observes which business keys pair; nothing is merged.",
        "merged": False,
        "entries": entries,
    }
