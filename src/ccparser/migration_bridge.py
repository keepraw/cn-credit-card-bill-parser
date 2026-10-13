"""Migration identity bridge (Task A-4.2). Read-only dry-run.

Joins legacy Python rows to Web native identities on BUSINESS keys only.
Native IDs are never compared and never rewritten here; the output is a
candidate mapping for human review plus a duplicate simulation.

No database access, no merging, no deletion, nothing irreversible.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass, field
from datetime import date
from decimal import Decimal
from typing import Any

BRIDGE_SCHEMA = "bridge/v1"
GENERATOR = "ccparser-bridge-py/1.0.0"

MATCHED = "MATCHED"
SUSPECTED = "SUSPECTED"
ORPHAN = "ORPHAN"

CONFIDENCE = {MATCHED: 0.95, SUSPECTED: 0.5, ORPHAN: 0.0}


@dataclass
class MigrationCandidate:
    pythonId: str
    webId: str | None
    candidateWebIds: list[str] = field(default_factory=list)
    matchType: str = ORPHAN
    confidence: float = 0.0
    reason: str = ""
    legacyRow: int | None = None
    edge: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


def derive_python_id(
    bank_native: str,
    card_last4: str,
    transaction_iso: str,
    posting_iso: str,
    settlement_minor: int,
    description: str,
) -> str:
    """Re-derive the Python transaction_id from export content.

    Mirrors dedupe.transaction_id (sha256 over bank/card/dates/money/description).
    money_key(Decimal(minor) / 100) is exact, so short-decimal amounts round-trip.
    """
    from .dedupe import transaction_id as compute_id
    from .models import Transaction

    tran = date.fromisoformat(transaction_iso)
    post = date.fromisoformat(posting_iso)
    amount = Decimal(settlement_minor) / 100
    tx = Transaction(
        bank=bank_native,
        card_last4=card_last4,
        transaction_date=tran,
        posting_date=post,
        description=description,
        transaction_currency="CNY",
        transaction_amount=amount,
        settlement_currency="CNY",
        settlement_amount=amount,
        source_file_name="",
        source_file_hash="",
        confidence=0.0,
        raw_text="",
    )
    return compute_id(tx)


def full_key(row: dict[str, Any]) -> str:
    return "|".join(str(row[k]) for k in (
        "bank", "cardLast4", "transactionDate", "postingDate",
        "settlementAmountMinor", "currency", "normalizedDescription",
    ))


def loose_key(row: dict[str, Any]) -> str:
    return "|".join(str(row[k]) for k in (
        "bank", "cardLast4", "transactionDate", "settlementAmountMinor", "currency",
    ))


def build_bridge(
    legacy_rows: list[dict[str, Any]],
    fresh_rows: list[dict[str, Any]],
    web_loose_map: dict[str, list[str]],
) -> list[MigrationCandidate]:
    """Three-level matching. Pure function; see module docstring for guarantees."""
    fresh_by_full = {full_key(r): r for r in fresh_rows}
    candidates: list[MigrationCandidate] = []
    for row in legacy_rows:
        python_id = row.get("pythonId", "")
        key, loose = full_key(row), loose_key(row)
        web_ids = web_loose_map.get(loose, [])
        if key in fresh_by_full and len(web_ids) == 1:
            candidates.append(MigrationCandidate(
                pythonId=python_id, webId=web_ids[0], candidateWebIds=web_ids,
                matchType=MATCHED, confidence=CONFIDENCE[MATCHED],
                reason="exact_business_key",
                legacyRow=row.get("sourceRow"), edge=row.get("edge"),
            ))
        elif key in fresh_by_full:
            candidates.append(MigrationCandidate(
                pythonId=python_id, webId=None, candidateWebIds=web_ids,
                matchType=SUSPECTED, confidence=CONFIDENCE[SUSPECTED],
                reason="exact_pipeline_key_but_no_unique_web_counterpart",
                legacyRow=row.get("sourceRow"), edge=row.get("edge"),
            ))
        elif web_ids:
            candidates.append(MigrationCandidate(
                pythonId=python_id, webId=None, candidateWebIds=web_ids,
                matchType=SUSPECTED, confidence=CONFIDENCE[SUSPECTED],
                reason="description_drift" if len(web_ids) == 1 else "multiple_web_candidates",
                legacyRow=row.get("sourceRow"), edge=row.get("edge"),
            ))
        else:
            candidates.append(MigrationCandidate(
                pythonId=python_id, webId=None, candidateWebIds=[],
                matchType=ORPHAN, confidence=CONFIDENCE[ORPHAN],
                reason="no_counterpart_in_golden_scope",
                legacyRow=row.get("sourceRow"), edge=row.get("edge"),
            ))
    return candidates


def duplicate_simulation(candidates: list[MigrationCandidate]) -> dict[str, Any]:
    """Before/after duplicate counts for re-importing golden-scope bills.

    before: MATCHED rows would re-insert (same business fact, incompatible IDs,
    and the type dimension keeps them out of even the loose suspect bucket).
    after: mapping applied -> mapped rows skipped by webId lookup.
    No database involved; pure counts.
    """
    matched = sum(1 for c in candidates if c.matchType == MATCHED)
    suspected = sum(1 for c in candidates if c.matchType == SUSPECTED)
    orphan = sum(1 for c in candidates if c.matchType == ORPHAN)
    return {
        "before": {"duplicatesWouldInsert": matched, "scope": "golden-scope exact rows re-imported without mapping"},
        "after": {"duplicatesWouldInsert": 0, "skippedByMapping": matched, "reviewQueue": suspected},
        "orphanOutOfScope": orphan,
        "merged": False,
        "note": ("Orphans are history outside the 6 golden cycles, not duplicates. "
                 "Suspected rows need human review before any mapping is applied."),
    }
