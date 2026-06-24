from __future__ import annotations

import re
from datetime import date

from ccparser.models import ParsedStatement, SourceContext, Transaction
from ccparser.normalizers import normalize_spaces, parse_amount, parse_date

from .generic import parse_generic


def parse(context: SourceContext) -> ParsedStatement:
    if "中信银行信用卡" in context.text or "CITIC" in context.text.upper():
        statement = parse_citic_email(context)
        if statement.transactions:
            return statement
    return parse_generic(context, bank="中信银行", parser_name="citic")


def parse_citic_email(context: SourceContext) -> ParsedStatement:
    text = context.text
    statement_start, statement_end = extract_citic_period(text)
    transactions = extract_citic_transactions(context, (statement_end or date.today()).year)
    card_last4 = transactions[0].card_last4 if transactions else extract_citic_card_last4(text)
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
        bank="中信银行",
        card_last4=card_last4,
        statement_start=statement_start,
        statement_end=statement_end,
        transactions=transactions,
        confidence=0.92 if transactions and statement_start and statement_end else 0.55,
        parser_name="citic_email",
        warnings=warnings,
    )


def extract_citic_period(text: str) -> tuple[date | None, date | None]:
    match = re.search(
        r"记录了您\s*(\d{4}年\d{1,2}月\d{1,2}日)\s*至\s*(\d{4}年\d{1,2}月\d{1,2}日)\s*账户变动信息",
        text,
    )
    if match:
        return parse_date(match.group(1)), parse_date(match.group(2))
    return None, None


def extract_citic_card_last4(text: str) -> str:
    rows = re.findall(r"\b(\d{4})\s*\|\s*\d{8}\s*\|\s*\d{4}\s*\|", text)
    if rows:
        return rows[0]
    match = re.search(r"卡号\s+[\d*-]+(\d{3,4})\b", text)
    return match.group(1) if match else ""


def extract_citic_transactions(context: SourceContext, default_year: int) -> list[Transaction]:
    transactions: list[Transaction] = []
    for line in context.text.splitlines():
        normalized = normalize_spaces(line)
        transaction = parse_citic_transaction_line(normalized, context, default_year)
        if transaction:
            transactions.append(transaction)
    return transactions


def parse_citic_transaction_line(line: str, context: SourceContext, default_year: int) -> Transaction | None:
    parts = [part.strip() for part in line.split("|")]
    parts = [part for part in parts if part]
    if len(parts) != 6:
        return None
    transaction_date = parse_date(parts[0], default_year)
    posting_date = parse_date(parts[1], default_year)
    if not transaction_date or not posting_date:
        return None
    card_last4 = parts[2]
    if not re.fullmatch(r"\d{3,4}", card_last4):
        return None

    description = normalize_spaces(parts[3])
    transaction_currency, transaction_amount = parse_currency_amount(parts[4], description)
    settlement_currency, settlement_amount = parse_currency_amount(parts[5], description)
    if transaction_amount is None or settlement_amount is None:
        return None

    return Transaction(
        bank="中信银行",
        card_last4=card_last4,
        transaction_date=transaction_date,
        posting_date=posting_date,
        description=description,
        transaction_currency=transaction_currency,
        transaction_amount=transaction_amount,
        settlement_currency=settlement_currency,
        settlement_amount=settlement_amount,
        source_file_name=context.file_name,
        source_file_hash=context.file_hash,
        confidence=0.94,
        raw_text=line,
    )


def parse_currency_amount(value: str, description: str):
    match = re.match(r"^([A-Z]{3})\s+(.+)$", value.strip(), flags=re.IGNORECASE)
    if not match:
        return "CNY", None
    currency = normalize_currency(match.group(1))
    amount = parse_amount(match.group(2), description)
    return currency, amount


def normalize_currency(currency: str) -> str:
    upper = currency.upper()
    if upper in {"CNY", "RMB", "CHN"}:
        return "CNY"
    return upper
