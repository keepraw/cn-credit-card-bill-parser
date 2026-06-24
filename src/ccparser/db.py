from __future__ import annotations

import sqlite3
from pathlib import Path

from .models import ParsedStatement, Transaction


SCHEMA = """
CREATE TABLE IF NOT EXISTS processed_files (
    file_hash TEXT PRIMARY KEY,
    file_name TEXT NOT NULL,
    source_type TEXT NOT NULL,
    processed_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS statements (
    statement_key TEXT PRIMARY KEY,
    bank TEXT NOT NULL,
    card_last4 TEXT NOT NULL,
    statement_start TEXT,
    statement_end TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS statement_sources (
    statement_key TEXT NOT NULL,
    file_hash TEXT NOT NULL,
    file_name TEXT NOT NULL,
    source_type TEXT NOT NULL,
    PRIMARY KEY (statement_key, file_hash)
);

CREATE TABLE IF NOT EXISTS transactions (
    transaction_id TEXT PRIMARY KEY,
    statement_key TEXT NOT NULL,
    bank TEXT NOT NULL,
    card_last4 TEXT NOT NULL,
    transaction_date TEXT NOT NULL,
    posting_date TEXT NOT NULL,
    description TEXT NOT NULL,
    transaction_currency TEXT NOT NULL,
    transaction_amount TEXT NOT NULL,
    settlement_currency TEXT NOT NULL,
    settlement_amount TEXT NOT NULL,
    source_file_name TEXT NOT NULL,
    source_file_hash TEXT NOT NULL,
    confidence REAL NOT NULL,
    raw_text TEXT NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
"""


class Database:
    def __init__(self, path: Path):
        self.path = path
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.connection = sqlite3.connect(self.path)
        self.connection.row_factory = sqlite3.Row
        self.connection.executescript(SCHEMA)
        self.connection.commit()

    def close(self) -> None:
        self.connection.close()

    def file_processed(self, file_hash: str) -> bool:
        row = self.connection.execute(
            "SELECT 1 FROM processed_files WHERE file_hash = ?",
            (file_hash,),
        ).fetchone()
        return row is not None

    def mark_file_processed(self, file_hash: str, file_name: str, source_type: str) -> None:
        self.connection.execute(
            "INSERT OR IGNORE INTO processed_files (file_hash, file_name, source_type) VALUES (?, ?, ?)",
            (file_hash, file_name, source_type),
        )
        self.connection.commit()

    def upsert_statement(self, statement: ParsedStatement, statement_key: str, file_hash: str, file_name: str, source_type: str) -> None:
        self.connection.execute(
            """
            INSERT OR IGNORE INTO statements (statement_key, bank, card_last4, statement_start, statement_end)
            VALUES (?, ?, ?, ?, ?)
            """,
            (
                statement_key,
                statement.bank,
                statement.card_last4,
                statement.statement_start.isoformat() if statement.statement_start else "",
                statement.statement_end.isoformat() if statement.statement_end else "",
            ),
        )
        self.connection.execute(
            """
            INSERT OR IGNORE INTO statement_sources (statement_key, file_hash, file_name, source_type)
            VALUES (?, ?, ?, ?)
            """,
            (statement_key, file_hash, file_name, source_type),
        )
        self.connection.commit()

    def transaction_exists(self, transaction_id: str) -> bool:
        row = self.connection.execute(
            "SELECT 1 FROM transactions WHERE transaction_id = ?",
            (transaction_id,),
        ).fetchone()
        return row is not None

    def insert_transaction(self, transaction: Transaction) -> None:
        self.connection.execute(
            """
            INSERT INTO transactions (
                transaction_id, statement_key, bank, card_last4, transaction_date, posting_date,
                description, transaction_currency, transaction_amount, settlement_currency,
                settlement_amount, source_file_name, source_file_hash, confidence, raw_text
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                transaction.transaction_id,
                transaction.statement_key,
                transaction.bank,
                transaction.card_last4,
                transaction.transaction_date.isoformat(),
                transaction.posting_date.isoformat(),
                transaction.description,
                transaction.transaction_currency,
                str(transaction.transaction_amount),
                transaction.settlement_currency,
                str(transaction.settlement_amount),
                transaction.source_file_name,
                transaction.source_file_hash,
                transaction.confidence,
                transaction.raw_text,
            ),
        )
        self.connection.commit()

    def fetch_transactions(self) -> list[dict[str, object]]:
        rows = self.connection.execute(
            """
            SELECT t.bank, t.card_last4, s.statement_start, s.statement_end,
                   t.transaction_date, t.posting_date, t.description,
                   t.transaction_currency, t.transaction_amount, t.settlement_currency,
                   t.settlement_amount, t.source_file_name, t.source_file_hash,
                   t.confidence, t.raw_text
            FROM transactions t
            LEFT JOIN statements s ON s.statement_key = t.statement_key
            ORDER BY t.transaction_date, t.posting_date, t.bank, t.card_last4, t.description
            """
        ).fetchall()
        return [dict(row) for row in rows]
