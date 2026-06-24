from __future__ import annotations

from datetime import date

from .hash_utils import money_key, stable_hash
from .models import ParsedStatement, Transaction


def statement_key(bank: str, card_last4: str, statement_start: date | None, statement_end: date | None) -> str:
    return stable_hash(
        bank,
        card_last4,
        statement_start.isoformat() if statement_start else "",
        statement_end.isoformat() if statement_end else "",
    )


def transaction_id(transaction: Transaction) -> str:
    return stable_hash(
        transaction.bank,
        transaction.card_last4,
        transaction.transaction_date.isoformat(),
        transaction.posting_date.isoformat(),
        money_key(transaction.settlement_amount),
        transaction.description,
    )


def assign_ids(statement: ParsedStatement) -> str:
    key = statement_key(statement.bank, statement.card_last4, statement.statement_start, statement.statement_end)
    seen_base_ids: dict[str, int] = {}
    for transaction in statement.transactions:
        transaction.statement_key = key
        base_transaction_id = transaction_id(transaction)
        occurrence = seen_base_ids.get(base_transaction_id, 0) + 1
        seen_base_ids[base_transaction_id] = occurrence
        if occurrence == 1:
            transaction.transaction_id = base_transaction_id
        else:
            transaction.transaction_id = stable_hash(base_transaction_id, occurrence)
    return key
