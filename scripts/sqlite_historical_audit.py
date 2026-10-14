"""SQLite historical data audit (one-off, read-only).

Answers: "Will deleting Python and SQLite lose any historical transaction data?"

Compares the legacy SQLite transaction set (``data/statements.db``) against
the TypeScript complete set (version-1 JSON backups, i.e. IndexedDB exports)
using canonical per-transaction fingerprints -- never amount sums.

Read-only guarantees:
- SQLite is opened with ``mode=ro`` and ``PRAGMA query_only = ON``.
- Only SELECT/PRAGMA statements are executed (guarded; anything else raises).
- No VACUUM / UPDATE / INSERT / DELETE / DDL, no database writes, no moves.
- JSON backups, golden fixtures and migration outputs are only read.
- Findings are printed (and optionally written to a report file). Nothing is
  repaired: differences are listed with enough detail for manual follow-up.

Coverage notes (fail closed):
- SQLite ``transactions`` has no direction/type columns. Direction is derived
  from the settlement-amount sign (same rule the TS legacy adapter uses);
  type is inferred from the description with the token port below (same port
  as ``scripts/migration_audit.py``). A type-only difference is reported as a
  field mismatch for human review, never silently merged.
- Golden fixtures are desensitized references: counted for context but
  excluded from the completeness comparison (hashed merchants can never
  exact-match raw history).
- ``output/*.xlsx`` archives are view-only derivatives without stable IDs:
  noted, not used as a completeness source.

Exit codes: 0 = SAFE (no migration required), 1 = differences found,
2 = environment/usage error.
"""

from __future__ import annotations

import argparse
import glob
import hashlib
import json
import re
import sqlite3
import sys
from collections import Counter
from dataclasses import dataclass, field
from decimal import Decimal, InvalidOperation
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "src"))

from ccparser.golden import (  # noqa: E402
    BANK_TO_ID,
    currency_exponent,
    normalize_description,
)

BANK_MAP: dict[str, str] = dict(BANK_TO_ID)
BANK_MAP.update({v: v for v in ("boc", "bocom", "icbc", "ccb", "abc", "citic", "unknown")})

CURRENCY_ALIASES = {"RMB": "CNY", "CHN": "CNY", "人民币": "CNY", "￥": "CNY", "¥": "CNY", "": "CNY"}

BACKUP_FORMATS = ("credit-bill-manager-backup", "credit-card-data-backup")

#: Port of web classify.ts TYPE_TOKENS (via scripts/migration_audit.py), used
#: ONLY to give SQLite rows a comparable type. Exact proof lives in TS.
TYPE_TOKENS: tuple[tuple[str, str], ...] = (
    (r"^(?:分期利息|分期手续费)", "interest"),
    (r"^(?:分期扣款|每期入账|分期入账)", "installment_payment"),
    (r"^(?:分期(?:消费)?原始|商户分期(?!扣款)|消费\s*商户分期)", "installment_original"),
    (r"^(?:信用卡还款|还款|转账还款|自助还款|网上还款)", "payment"),
    (r"^(?:退货|退款|退汇)", "refund"),
    (r"^(?:刷卡金|返现|返还|积分兑换|优惠)", "cashback"),
    (r"^(?:手续费|年费|服务费|短信服务费|短信费|违约金)", "fee"),
    (r"^(?:利息|透支利息|计息)", "interest"),
    (r"^(?:取现|预借现金)", "cash_advance"),
    (r"^(?:消费|购物|支付)", "purchase"),
    (r"^(?:调整|冲正|其他)", "adjustment"),
)


def infer_legacy_type(description: str, direction: str) -> str:
    head = (description or "").strip()
    for pattern, tx_type in TYPE_TOKENS:
        if re.match(pattern, head):
            return tx_type
    return "purchase" if direction == "debit" else "payment"


class AuditError(Exception):
    """Environment/usage error: refuse to declare SAFE on garbage."""


# ---------------------------------------------------------------------------
# Read-only SQLite access
# ---------------------------------------------------------------------------

_READ_PREFIXES = ("SELECT", "PRAGMA", "EXPLAIN", "WITH")


def guarded_execute(conn: sqlite3.Connection, sql: str, params: tuple = ()) -> sqlite3.Cursor:
    """Execute only read statements. Anything else raises (defense in depth)."""
    cleaned = sql.strip().lstrip("(")
    upper = cleaned.upper()
    if not upper.startswith(_READ_PREFIXES):
        raise AuditError(f"refused non-read SQL: {sql[:60]!r}")
    if ";" in cleaned.strip().rstrip(";"):
        raise AuditError("refused multi-statement SQL")
    return conn.execute(sql, params)


def ro_connect(db_path: Path) -> sqlite3.Connection:
    try:
        conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    except sqlite3.Error as exc:
        raise AuditError(f"cannot open SQLite database read-only: {exc}") from exc
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA query_only = ON")
    return conn


def inspect_db_files(db_path: Path) -> dict[str, dict[str, object]]:
    info: dict[str, dict[str, object]] = {}
    for suffix in ("", "-wal", "-shm"):
        candidate = Path(str(db_path) + suffix)
        info[candidate.name] = {
            "exists": candidate.exists(),
            "size": candidate.stat().st_size if candidate.exists() else 0,
        }
    return info


# ---------------------------------------------------------------------------
# Normalization (shared canonical form for both sides)
# ---------------------------------------------------------------------------

FINGERPRINT_FIELDS = (
    "bank",
    "card",
    "transaction_date",
    "posting_date",
    "normalized_description",
    "original_currency",
    "original_minor",
    "settlement_currency",
    "settlement_minor",
    "direction",
    "type",
)

#: Identity without type: duplicate grouping and loose matching must not split
#: on inferred-vs-stored classifier metadata.
IDENTITY_FIELDS = tuple(f for f in FINGERPRINT_FIELDS if f != "type")


def norm_bank(raw: object) -> str:
    text = str(raw or "").strip()
    if text in BANK_MAP:
        return BANK_MAP[text]
    lowered = text.lower()
    return BANK_MAP.get(lowered, "unknown")


def norm_card(raw: object) -> str:
    if raw is None:
        return "????"
    digits = re.sub(r"\D", "", str(raw).strip().removesuffix(".0"))
    if not digits:
        return "????"
    return digits[-4:].rjust(4, "0")


def norm_date(raw: object) -> str:
    return str(raw or "").strip()


def norm_currency(raw: object) -> str:
    text = str(raw or "").strip().upper()
    return CURRENCY_ALIASES.get(text, text or "CNY")


def decimal_to_minor_strict(raw: object, currency: str) -> int | None:
    """Major-unit decimal text -> integer minor units. None when unparseable."""
    if raw is None:
        return None
    if isinstance(raw, bool):
        return None
    if isinstance(raw, int):
        return raw
    if isinstance(raw, float):
        if abs(raw * 100 - round(raw * 100)) > 1e-6:
            return None
        raw = str(raw)
    text = str(raw).strip().replace(",", "").lstrip("¥￥").strip()
    if text.startswith("(") and text.endswith(")"):
        text = "-" + text[1:-1]
    try:
        amount = Decimal(text)
    except InvalidOperation:
        return None
    exp = currency_exponent(currency)
    scaled = amount * (10**exp)
    if scaled != scaled.to_integral_value():
        return None
    return int(scaled)


def minor_to_decimal(minor: int, currency: str) -> str:
    exp = currency_exponent(currency)
    negative = minor < 0
    digits = str(abs(minor))
    if exp == 0:
        out = digits
    else:
        padded = digits.rjust(exp + 1, "0")
        out = f"{padded[:-exp]}.{padded[-exp:]}"
    return f"-{out}" if negative else out


def direction_for_minor(minor: int) -> str:
    return "credit" if minor < 0 else "debit"


@dataclass
class CanonicalTx:
    bank: str
    card: str
    transaction_date: str
    posting_date: str
    normalized_description: str
    raw_description: str
    original_currency: str
    original_minor: int
    settlement_currency: str
    settlement_minor: int
    direction: str
    type: str
    fingerprint: str = ""
    provenance: str = ""
    detail: dict = field(default_factory=dict)

    def __post_init__(self) -> None:
        parts = sorted(f"{name}={getattr(self, name)}" for name in FINGERPRINT_FIELDS)
        self.fingerprint = hashlib.sha256("|".join(parts).encode("utf-8")).hexdigest()

    def identity_key(self) -> str:
        parts = sorted(f"{name}={getattr(self, name)}" for name in IDENTITY_FIELDS)
        return hashlib.sha256("|".join(parts).encode("utf-8")).hexdigest()

    def loose_key(self) -> str:
        return "|".join((
            self.bank, self.card, self.transaction_date,
            str(self.settlement_minor), self.settlement_currency,
        ))

    def short(self) -> str:
        return (
            f"fp={self.fingerprint[:12]} bank={self.bank} card={self.card} "
            f"txn={self.transaction_date} post={self.posting_date} "
            f"{self.original_currency} {minor_to_decimal(self.original_minor, self.original_currency)} / "
            f"{self.settlement_currency} {minor_to_decimal(self.settlement_minor, self.settlement_currency)} "
            f"{self.direction}/{self.type} desc={self.normalized_description[:60]!r} src={self.provenance}"
        )


def sqlite_row_to_canonical(row: sqlite3.Row) -> CanonicalTx | None:
    """Return None when the row cannot be normalized (caller records it)."""
    bank = norm_bank(row["bank"])
    card = norm_card(row["card_last4"])
    txn_date = norm_date(row["transaction_date"])
    post_date = norm_date(row["posting_date"])
    raw_desc = re.sub(r"\s+", " ", str(row["description"] or "").replace("　", " ").strip())
    orig_ccy = norm_currency(row["transaction_currency"])
    stl_ccy = norm_currency(row["settlement_currency"])
    orig_minor = decimal_to_minor_strict(row["transaction_amount"], orig_ccy)
    stl_minor = decimal_to_minor_strict(row["settlement_amount"], stl_ccy)
    if orig_minor is None or stl_minor is None:
        return None
    direction = direction_for_minor(stl_minor)
    tx_type = infer_legacy_type(raw_desc, direction)
    tx_id = str(row["transaction_id"] or "")
    return CanonicalTx(
        bank=bank, card=card, transaction_date=txn_date, posting_date=post_date,
        normalized_description=normalize_description(raw_desc), raw_description=raw_desc,
        original_currency=orig_ccy, original_minor=orig_minor,
        settlement_currency=stl_ccy, settlement_minor=stl_minor,
        direction=direction, type=tx_type,
        provenance=f"sqlite:{tx_id[:12]}…/{row['source_file_name']}",
        detail={"sqlite_id": tx_id, "statement_key": str(row["statement_key"] or "")},
    )


def ts_row_to_canonical(tx: dict, backup_name: str, index: int) -> CanonicalTx:
    def need(name: str) -> object:
        if name not in tx:
            raise AuditError(f"backup {backup_name}: transaction #{index} missing field {name!r}")
        return tx[name]

    raw_id = need("id")
    for name in ("transactionAmountMinor", "settlementAmountMinor"):
        value = need(name)
        if not isinstance(value, int) or isinstance(value, bool):
            raise AuditError(f"backup {backup_name}: transaction {raw_id!r} has non-integer {name}")
    direction = need("direction")
    if direction not in ("debit", "credit"):
        raise AuditError(f"backup {backup_name}: transaction {raw_id!r} has bad direction")
    tx_type = need("type")
    if not isinstance(tx_type, str) or not tx_type:
        raise AuditError(f"backup {backup_name}: transaction {raw_id!r} has bad type")
    raw_desc = re.sub(r"\s+", " ", str(need("description")).replace("　", " ").strip())
    return CanonicalTx(
        bank=norm_bank(need("bank")),
        card=str(need("cardLast4") or "????"),
        transaction_date=str(tx.get("transactionDate") or ""),
        posting_date=str(tx.get("postingDate") or ""),
        normalized_description=normalize_description(raw_desc),
        raw_description=raw_desc,
        original_currency=norm_currency(need("transactionCurrency")),
        original_minor=tx["transactionAmountMinor"],  # type: ignore[index]
        settlement_currency=norm_currency(need("settlementCurrency")),
        settlement_minor=tx["settlementAmountMinor"],  # type: ignore[index]
        direction=direction,  # type: ignore[arg-type]
        type=tx_type,
        provenance=f"ts:{str(raw_id)[:12]}…/{tx.get('sourceFileName', '')}",
        detail={"ts_id": str(raw_id)},
    )


# ---------------------------------------------------------------------------
# Loading
# ---------------------------------------------------------------------------

SQLITE_TX_COLUMNS = (
    "transaction_id", "statement_key", "bank", "card_last4",
    "transaction_date", "posting_date", "description",
    "transaction_currency", "transaction_amount",
    "settlement_currency", "settlement_amount", "source_file_name",
)


def load_sqlite(db_path: Path) -> tuple[list[CanonicalTx], list[str], list[str]]:
    """Returns (rows, notes, warnings). Missing file means zero rows, not error."""
    if not db_path.exists():
        return [], [f"SQLite database not found at {db_path} (nothing to audit)"], []
    notes = [f"SQLite database: {db_path}"]
    conn = ro_connect(db_path)
    try:
        tables = {r[0] for r in guarded_execute(conn, "SELECT name FROM sqlite_master WHERE type = 'table'")}
        if "transactions" not in tables:
            raise AuditError("SQLite database has no 'transactions' table")
        cols = {r[1] for r in guarded_execute(conn, "PRAGMA table_info(transactions)")}
        missing = [c for c in SQLITE_TX_COLUMNS if c not in cols]
        if missing:
            raise AuditError(f"SQLite transactions table missing columns: {', '.join(missing)}")
        count = guarded_execute(conn, "SELECT COUNT(*) FROM transactions").fetchone()[0]
        notes.append(f"SQLite transactions table holds {count} stored rows")
        rows: list[CanonicalTx] = []
        warnings: list[str] = []
        cursor = guarded_execute(
            conn, f"SELECT rowid, {', '.join(SQLITE_TX_COLUMNS)} FROM transactions ORDER BY rowid"
        )
        for record in cursor:
            canonical = sqlite_row_to_canonical(record)
            if canonical is None:
                warnings.append(
                    f"SQLite rowid={record['rowid']} id={str(record['transaction_id'])[:12]}… "
                    f"has unparseable amount "
                    f"({record['transaction_currency']} {record['transaction_amount']!r} / "
                    f"{record['settlement_currency']} {record['settlement_amount']!r}); "
                    "kept as SQLite-only for manual review"
                )
                raw_desc = re.sub(r"\s+", " ", str(record["description"] or "").strip())
                rows.append(CanonicalTx(
                    bank=norm_bank(record["bank"]), card=norm_card(record["card_last4"]),
                    transaction_date=norm_date(record["transaction_date"]),
                    posting_date=norm_date(record["posting_date"]),
                    normalized_description=normalize_description(raw_desc), raw_description=raw_desc,
                    original_currency=norm_currency(record["transaction_currency"]), original_minor=0,
                    settlement_currency=norm_currency(record["settlement_currency"]), settlement_minor=0,
                    direction="debit", type="__unparseable__",
                    provenance=f"sqlite:{str(record['transaction_id'])[:12]}…/{record['source_file_name']}",
                    detail={"sqlite_id": str(record["transaction_id"]), "unparseable": True},
                ))
            else:
                rows.append(canonical)
        return rows, notes, warnings
    finally:
        conn.close()


def load_backup(path: Path) -> tuple[list[dict], int]:
    """Returns (raw transactions, demo-skipped count). Raises AuditError."""
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise AuditError(f"cannot read backup {path}: {exc}") from exc
    if not isinstance(payload, dict) or payload.get("format") not in BACKUP_FORMATS:
        raise AuditError(f"backup {path} is not a version-1 JSON backup")
    if payload.get("version") != 1 or not isinstance(payload.get("transactions"), list):
        raise AuditError(f"backup {path} is not a version-1 JSON backup")
    skipped = 0
    rows = []
    for tx in payload["transactions"]:
        if isinstance(tx, dict) and tx.get("isDemo") is True:
            skipped += 1
            continue
        rows.append(tx)
    return rows, skipped


def load_ts(backups: list[Path]) -> tuple[dict[str, CanonicalTx], list[str], list[str], int, int]:
    """Returns (by_id, notes, warnings, conflict_count, demo_skipped)."""
    by_id: dict[str, CanonicalTx] = {}
    notes: list[str] = []
    warnings: list[str] = []
    conflicts = 0
    demo_total = 0
    dup_skipped = 0
    for path in backups:
        raw_rows, skipped = load_backup(path)
        demo_total += skipped
        notes.append(f"backup {path}: {len(raw_rows)} transactions ({skipped} demo skipped)")
        for index, tx in enumerate(raw_rows):
            canonical = ts_row_to_canonical(tx, path.name, index)
            tx_id = canonical.detail["ts_id"]
            existing = by_id.get(tx_id)
            if existing is None:
                by_id[tx_id] = canonical
            else:
                dup_skipped += 1
                if existing.fingerprint != canonical.fingerprint:
                    conflicts += 1
                    warnings.append(
                        f"backup conflict for id {tx_id[:24]}…: "
                        f"{path.name}#{index} differs from earlier backup "
                        f"(kept first; needs manual review)"
                    )
    if dup_skipped:
        notes.append(f"duplicate ids across backups skipped: {dup_skipped}")
    return by_id, notes, warnings, conflicts, demo_total


def load_golden_reference(golden_dir: Path) -> tuple[int, str]:
    """Count desensitized web.json rows for context. Never used for matching."""
    if not golden_dir.exists():
        return 0, f"golden dir {golden_dir} not found (reference skipped)"
    count = 0
    for web_path in sorted(golden_dir.glob("*/*/web.json")):
        try:
            doc = json.loads(web_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        if isinstance(doc, dict) and isinstance(doc.get("transactions"), list):
            count += len(doc["transactions"])
    return count, (
        f"golden reference rows (desensitized, excluded from comparison): {count}"
    )


def scan_migration_outputs(output_dir: Path) -> str:
    files = sorted(p for p in output_dir.glob("*.xlsx") if p.is_file()) if output_dir.exists() else []
    if not files:
        return "migration outputs (output/*.xlsx): none found"
    total = sum(p.stat().st_size for p in files)
    return f"migration outputs: {len(files)} xlsx file(s), {total} bytes (view-only, not a completeness source)"


# ---------------------------------------------------------------------------
# Comparison
# ---------------------------------------------------------------------------

@dataclass
class AuditResult:
    sqlite_total: int
    ts_total: int
    sqlite_only: list[CanonicalTx] = field(default_factory=list)
    ts_only: list[CanonicalTx] = field(default_factory=list)
    field_mismatches: list[tuple[CanonicalTx, CanonicalTx, list[str]]] = field(default_factory=list)
    duplicate_mismatches: list[tuple[str, list[CanonicalTx], list[CanonicalTx]]] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)
    notes: list[str] = field(default_factory=list)


def compare(sqlite_rows: list[CanonicalTx], ts_by_id: dict[str, CanonicalTx]) -> AuditResult:
    ts_rows = list(ts_by_id.values())
    result = AuditResult(sqlite_total=len(sqlite_rows), ts_total=len(ts_rows))

    # Pass 1: exact fingerprint multiset (fingerprint includes inferred/stored type).
    sqlite_by_fp: dict[str, list[CanonicalTx]] = {}
    for row in sqlite_rows:
        sqlite_by_fp.setdefault(row.fingerprint, []).append(row)
    ts_by_fp: dict[str, list[CanonicalTx]] = {}
    for row in ts_rows:
        ts_by_fp.setdefault(row.fingerprint, []).append(row)
    sqlite_left: list[CanonicalTx] = []
    ts_left: list[CanonicalTx] = []
    for fp, s_rows in sqlite_by_fp.items():
        t_rows = ts_by_fp.pop(fp, [])
        paired = min(len(s_rows), len(t_rows))
        sqlite_left.extend(s_rows[paired:])
        ts_left.extend(t_rows[paired:])
    for t_rows in ts_by_fp.values():
        ts_left.extend(t_rows)

    # Pass 2: loose-key fallback turns description/direction/type drift into
    # field mismatches instead of false missing/extra rows.
    sqlite_by_loose: dict[str, list[CanonicalTx]] = {}
    for row in sqlite_left:
        sqlite_by_loose.setdefault(row.loose_key(), []).append(row)
    ts_by_loose: dict[str, list[CanonicalTx]] = {}
    for row in ts_left:
        ts_by_loose.setdefault(row.loose_key(), []).append(row)
    still_sqlite: list[CanonicalTx] = []
    still_ts: list[CanonicalTx] = []
    for key, s_rows in sqlite_by_loose.items():
        t_rows = ts_by_loose.pop(key, [])
        while s_rows and t_rows:
            s_row, t_row = s_rows.pop(0), t_rows.pop(0)
            differing = [name for name in FINGERPRINT_FIELDS if getattr(s_row, name) != getattr(t_row, name)]
            result.field_mismatches.append((s_row, t_row, differing or ["<unknown>"]))
        still_sqlite.extend(s_rows)
        still_ts.extend(t_rows)
    for t_rows in ts_by_loose.values():
        still_ts.extend(t_rows)
    result.sqlite_only = sorted(still_sqlite, key=lambda r: (r.transaction_date, r.posting_date, r.fingerprint))
    result.ts_only = sorted(still_ts, key=lambda r: (r.transaction_date, r.posting_date, r.fingerprint))

    # Pass 3: duplicate relationships per identity key (type excluded so that
    # inferred-vs-stored classifier metadata never splits a duplicate group).
    # Only keys present on BOTH sides with differing occurrence counts are
    # reported here; keys exclusive to one side are already covered by the
    # missing/extra sections above.
    sqlite_groups: dict[str, list[CanonicalTx]] = {}
    for row in sqlite_rows:
        if not row.detail.get("unparseable"):
            sqlite_groups.setdefault(row.identity_key(), []).append(row)
    ts_groups: dict[str, list[CanonicalTx]] = {}
    for row in ts_rows:
        ts_groups.setdefault(row.identity_key(), []).append(row)
    for key in sorted(set(sqlite_groups) & set(ts_groups)):
        s_rows = sqlite_groups[key]
        t_rows = ts_groups[key]
        if len(s_rows) != len(t_rows):
            result.duplicate_mismatches.append((key, s_rows, t_rows))

    return result


# ---------------------------------------------------------------------------
# Report
# ---------------------------------------------------------------------------

def build_report(result: AuditResult, max_details: int = 20) -> tuple[str, bool]:
    migration_required = bool(
        result.sqlite_only or result.ts_only or result.field_mismatches
        or result.duplicate_mismatches or result.warnings
    )
    lines = [
        "SQLite Historical Audit",
        "",
        "SQLite transactions:",
        str(result.sqlite_total),
        "",
        "TypeScript transactions:",
        str(result.ts_total),
        "",
        "SQLite only transactions:",
        str(len(result.sqlite_only)),
        "",
        "TypeScript only transactions:",
        str(len(result.ts_only)),
        "",
        "Field mismatches:",
        str(len(result.field_mismatches)),
        "",
        "Duplicate relationship mismatches:",
        str(len(result.duplicate_mismatches)),
        "",
        "Migration required:",
        "YES" if migration_required else "NO",
        "",
        "Python removal:",
        "NOT SAFE" if migration_required else "SAFE",
        "",
    ]

    def capped(items: list, render) -> None:
        for item in items[:max_details]:
            lines.append(f"- {render(item)}")
        if len(items) > max_details:
            lines.append(f"- … and {len(items) - max_details} more")

    lines.append("Sources:")
    for note in result.notes:
        lines.append(f"- {note}")
    lines.append("")
    if result.warnings:
        lines.append("Warnings (fail closed; each needs manual review):")
        capped(result.warnings, str)
        lines.append("")
    if result.sqlite_only:
        lines.append("Missing in TypeScript (SQLite only):")
        capped(result.sqlite_only, lambda r: r.short())
        lines.append("")
    if result.ts_only:
        lines.append("Missing in SQLite (TypeScript only):")
        capped(result.ts_only, lambda r: r.short())
        lines.append("")
    if result.field_mismatches:
        lines.append("Field mismatches (same business event, differing fields):")
        for s_row, t_row, differing in result.field_mismatches[:max_details]:
            lines.append(f"- fp={s_row.fingerprint[:12]} differs on: {', '.join(differing)}")
            lines.append(f"  sqlite: {s_row.short()}")
            lines.append(f"  ts:     {t_row.short()}")
        if len(result.field_mismatches) > max_details:
            lines.append(f"- … and {len(result.field_mismatches) - max_details} more")
        lines.append("")
    if result.duplicate_mismatches:
        lines.append("Duplicate relationship mismatches (occurrence counts differ):")
        for key, s_rows, t_rows in result.duplicate_mismatches[:max_details]:
            sample = (s_rows + t_rows)[:1]
            anchor = sample[0].short() if sample else f"key={key[:12]}"
            lines.append(f"- sqlite_occurrences={len(s_rows)} ts_occurrences={len(t_rows)} e.g. {anchor}")
        if len(result.duplicate_mismatches) > max_details:
            lines.append(f"- … and {len(result.duplicate_mismatches) - max_details} more")
        lines.append("")
    if not migration_required:
        lines.append("No differences found. Nothing to migrate.")
        lines.append("")
    return "\n".join(lines), migration_required


def discover_backups(patterns: list[str]) -> list[Path]:
    found: list[Path] = []
    for pattern in patterns:
        for match in sorted(glob.glob(pattern, recursive=True)):
            path = Path(match)
            if path.is_file() and path not in found:
                found.append(path)
    return found


DEFAULT_BACKUP_PATTERNS = [
    "backups/**/credit-card-data-*.json",
    "backups/**/*.json",
]


def run_audit(
    db_path: Path,
    backups: list[Path],
    golden_dir: Path,
    output_dir: Path,
    max_details: int = 20,
) -> tuple[str, bool]:
    file_info = inspect_db_files(db_path)
    main = file_info.get(db_path.name, {})
    notes = [
        f"db files: {db_path.name} exists={main.get('exists')} size={main.get('size')} | "
        f"{db_path.name}-wal exists={file_info.get(db_path.name + '-wal', {}).get('exists')} "
        f"size={file_info.get(db_path.name + '-wal', {}).get('size')} | "
        f"{db_path.name}-shm exists={file_info.get(db_path.name + '-shm', {}).get('exists')} "
        f"size={file_info.get(db_path.name + '-shm', {}).get('size')}"
    ]
    sqlite_rows, sqlite_notes, sqlite_warnings = load_sqlite(db_path)
    notes.extend(sqlite_notes)

    ts_by_id: dict[str, CanonicalTx] = {}
    ts_warnings: list[str] = []
    if backups:
        ts_by_id, ts_notes, ts_warnings, conflicts, _ = load_ts(backups)
        notes.extend(ts_notes)
        if conflicts:
            ts_warnings.append(f"{conflicts} id conflict(s) across backups (counted as warnings)")
    else:
        notes.append("no TypeScript JSON backups provided/found (TypeScript set is empty)")

    golden_count, golden_note = load_golden_reference(golden_dir)
    notes.append(golden_note)
    notes.append(scan_migration_outputs(output_dir))

    result = compare(sqlite_rows, ts_by_id)
    result.notes = notes
    result.warnings = [*sqlite_warnings, *ts_warnings]
    if golden_count and (result.sqlite_only or result.ts_only):
        result.notes.append(
            "note: golden fixtures are desensitized and were excluded; "
            "raw-history identity was compared SQLite-vs-backup only"
        )
    return build_report(result, max_details)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="SQLite historical data audit (read-only, one-off).")
    parser.add_argument("--db", default="data/statements.db", help="Legacy SQLite database path.")
    parser.add_argument(
        "--backup", action="append", default=[],
        help="Version-1 JSON backup file or glob. Repeatable. "
             "Defaults to backups/**/credit-card-data-*.json when omitted.",
    )
    parser.add_argument("--golden-dir", default="golden", help="Golden fixtures dir (reference only).")
    parser.add_argument("--output-dir", default="output", help="Migration output dir (noted only).")
    parser.add_argument("--report-out", default=None, help="Also write the report to this file.")
    parser.add_argument("--max-details", type=int, default=20, help="Max detail rows per section.")
    args = parser.parse_args(argv)

    try:
        patterns = args.backup or DEFAULT_BACKUP_PATTERNS
        backups = discover_backups(patterns)
        if args.backup and not backups:
            raise AuditError(f"no backups matched: {args.backup}")
        report, migration_required = run_audit(
            Path(args.db), backups, Path(args.golden_dir), Path(args.output_dir), args.max_details
        )
    except AuditError as exc:
        print(f"audit error: {exc}", file=sys.stderr)
        return 2
    print(report)
    if args.report_out:
        Path(args.report_out).write_text(report + "\n", encoding="utf-8")
    return 1 if migration_required else 0


if __name__ == "__main__":
    raise SystemExit(main())
