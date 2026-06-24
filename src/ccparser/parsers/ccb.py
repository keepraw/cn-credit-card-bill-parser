from __future__ import annotations

import re

from ccparser.models import ParsedStatement, SourceContext, Transaction
from ccparser.normalizers import normalize_spaces, parse_amount, parse_date

from .generic import parse_generic


def parse(context: SourceContext) -> ParsedStatement:
    if "中国建设银行" in context.text or "龙卡信用卡对账单" in context.text:
        statement = parse_ccb_email(context)
        if statement.transactions:
            return statement
    return parse_generic(context, bank="建设银行", parser_name="ccb")


def parse_ccb_email(context: SourceContext) -> ParsedStatement:
    statement_start, statement_end = extract_ccb_period(context.text)
    transactions = extract_ccb_transactions(context)
    card_last4 = transactions[0].card_last4 if transactions else extract_ccb_card_last4(context.text)

    warnings: list[str] = []
    if not card_last4:
        warnings.append("missing_card_last4")
    if not statement_start or not statement_end:
        warnings.append("missing_statement_period")
    if not transactions:
        warnings.append("no_transactions_found")

    for transaction in transactions:
        if not transaction.card_last4:
            transaction.card_last4 = card_last4

    return ParsedStatement(
        bank="建设银行",
        card_last4=card_last4,
        statement_start=statement_start,
        statement_end=statement_end,
        transactions=transactions,
        confidence=0.95 if transactions and statement_start and statement_end else 0.55,
        parser_name="ccb_email",
        warnings=warnings,
    )


def extract_ccb_period(text: str):
    patterns = [
        r"账单周期\s*Statement Cycle\s*\|?\s*(\d{4}/\d{1,2}/\d{1,2})\s*-\s*(\d{4}/\d{1,2}/\d{1,2})",
        r"以下为您\s*(\d{4}年\d{1,2}月\d{1,2}日)\s*至\s*(\d{4}年\d{1,2}月\d{1,2}日)",
    ]
    for pattern in patterns:
        match = re.search(pattern, text)
        if match:
            return parse_date(match.group(1)), parse_date(match.group(2))
    return None, None


def extract_ccb_card_last4(text: str) -> str:
    match = re.search(r"\*{3,}(\d{4})", text)
    if match:
        return match.group(1)
    match = re.search(r"\|\s*(\d{4})\s*\|\s*[\u4e00-\u9fffA-Z]", text)
    return match.group(1) if match else ""


def extract_ccb_transactions(context: SourceContext) -> list[Transaction]:
    transactions: list[Transaction] = []
    active = False
    for line in context.text.splitlines():
        normalized = normalize_spaces(line)
        if "【交易明细】" in normalized:
            active = True
            continue
        if active and ("*** 结束" in normalized or "The End" in normalized):
            active = False
        if not active:
            continue
        transaction = parse_ccb_transaction_line(normalized, context)
        if transaction:
            transactions.append(transaction)
    return transactions


def parse_ccb_transaction_line(line: str, context: SourceContext) -> Transaction | None:
    parts = [part.strip() for part in line.split("|")]
    parts = [part for part in parts if part]
    if len(parts) != 8:
        return None

    transaction_date_text, posting_date_text, card_last4, description, transaction_currency, transaction_amount_text, settlement_currency, settlement_amount_text = parts
    if not re.fullmatch(r"\d{4}", card_last4):
        return None

    transaction_date = parse_date(transaction_date_text)
    posting_date = parse_date(posting_date_text)
    if not transaction_date or not posting_date:
        return None

    transaction_amount = parse_amount(transaction_amount_text)
    settlement_amount = parse_amount(settlement_amount_text)
    if transaction_amount is None or settlement_amount is None:
        return None

    return Transaction(
        bank="建设银行",
        card_last4=card_last4,
        transaction_date=transaction_date,
        posting_date=posting_date,
        description=normalize_spaces(description),
        transaction_currency=normalize_ccb_currency(transaction_currency),
        transaction_amount=transaction_amount,
        settlement_currency=normalize_ccb_currency(settlement_currency),
        settlement_amount=settlement_amount,
        source_file_name=context.file_name,
        source_file_hash=context.file_hash,
        confidence=0.96,
        raw_text=line,
    )


def normalize_ccb_currency(currency: str) -> str:
    upper = currency.upper()
    if upper in {"RMB", "CNY", "CHN"}:
        return "CNY"
    return upper
