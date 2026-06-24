from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date
from decimal import Decimal
from pathlib import Path
from typing import Any


@dataclass(frozen=True)
class SourceContext:
    path: Path
    file_name: str
    file_hash: str
    source_type: str
    text: str
    tables: list[list[dict[str, Any]]] = field(default_factory=list)


@dataclass
class Transaction:
    bank: str
    card_last4: str
    transaction_date: date
    posting_date: date
    description: str
    transaction_currency: str
    transaction_amount: Decimal
    settlement_currency: str
    settlement_amount: Decimal
    source_file_name: str
    source_file_hash: str
    confidence: float
    raw_text: str
    transaction_id: str = ""
    statement_key: str = ""

    def as_output_row(self) -> dict[str, Any]:
        return {
            "bank": self.bank,
            "card_last4": self.card_last4,
            "transaction_date": self.transaction_date.isoformat(),
            "posting_date": self.posting_date.isoformat(),
            "description": self.description,
            "transaction_currency": self.transaction_currency,
            "transaction_amount": float(self.transaction_amount),
            "settlement_currency": self.settlement_currency,
            "settlement_amount": float(self.settlement_amount),
            "source_file_name": self.source_file_name,
            "source_file_hash": self.source_file_hash,
            "confidence": self.confidence,
            "raw_text": self.raw_text,
        }


@dataclass
class ParsedStatement:
    bank: str
    card_last4: str
    statement_start: date | None
    statement_end: date | None
    transactions: list[Transaction]
    confidence: float
    parser_name: str
    warnings: list[str] = field(default_factory=list)


@dataclass
class ReviewItem:
    reason: str
    source_file_name: str
    source_file_hash: str
    bank: str = ""
    card_last4: str = ""
    transaction_id: str = ""
    statement_key: str = ""
    detail: str = ""
    raw_text: str = ""

    def as_output_row(self) -> dict[str, Any]:
        return {
            "reason": self.reason,
            "source_file_name": self.source_file_name,
            "source_file_hash": self.source_file_hash,
            "bank": self.bank,
            "card_last4": self.card_last4,
            "transaction_id": self.transaction_id,
            "statement_key": self.statement_key,
            "detail": self.detail,
            "raw_text": self.raw_text,
        }
