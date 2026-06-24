from __future__ import annotations

import re
from decimal import Decimal

from ccparser.models import ParsedStatement, SourceContext, Transaction
from ccparser.normalizers import normalize_spaces, parse_amount, parse_date

from .generic import parse_generic


def parse(context: SourceContext) -> ParsedStatement:
    if "工商银行信用卡" in context.text or "人民币(本位币) 交 易 明 细" in context.text:
        statement = parse_icbc_email(context)
        if statement.transactions:
            return statement
    return parse_generic(context, bank="工商银行", parser_name="icbc")


def parse_icbc_email(context: SourceContext) -> ParsedStatement:
    statement_start, statement_end = extract_icbc_period(context.text)
    transactions = extract_icbc_transactions(context)
    card_last4 = transactions[0].card_last4 if transactions else extract_icbc_card_last4(context.text)

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
        bank="工商银行",
        card_last4=card_last4,
        statement_start=statement_start,
        statement_end=statement_end,
        transactions=transactions,
        confidence=0.95 if transactions and statement_start and statement_end else 0.55,
        parser_name="icbc_email",
        warnings=warnings,
    )


def extract_icbc_period(text: str):
    match = re.search(
        r"账单周期\s*(\d{4}年\d{1,2}月\d{1,2}日)\s*[—\-~至到]\s*(\d{4}年\d{1,2}月\d{1,2}日)",
        text,
    )
    if match:
        return parse_date(match.group(1)), parse_date(match.group(2))
    return None, None


def extract_icbc_card_last4(text: str) -> str:
    match = re.search(r"(\d{4})\(牡丹贷记卡\)", text)
    if match:
        return match.group(1)
    match = re.search(r"^(\d{4})\s*\|", text, flags=re.MULTILINE)
    return match.group(1) if match else ""


def extract_icbc_transactions(context: SourceContext) -> list[Transaction]:
    transactions: list[Transaction] = []
    active = False
    for line in context.text.splitlines():
        normalized = normalize_spaces(line)
        if "人民币(本位币) 交 易 明 细" in normalized:
            active = True
            continue
        if active and ("工 银i 豆" in normalized or "温馨提示" in normalized):
            active = False
        if not active:
            continue
        transaction = parse_icbc_transaction_line(normalized, context)
        if transaction:
            transactions.append(transaction)
    return transactions


def parse_icbc_transaction_line(line: str, context: SourceContext) -> Transaction | None:
    parts = [part.strip() for part in line.split("|")]
    parts = [part for part in parts if part]
    if len(parts) != 7:
        return None

    card_last4, transaction_date_text, posting_date_text, transaction_type, merchant, transaction_amount_text, settlement_amount_text = parts
    if not re.fullmatch(r"\d{4}", card_last4):
        return None

    transaction_date = parse_date(transaction_date_text)
    posting_date = parse_date(posting_date_text)
    if not transaction_date or not posting_date:
        return None

    transaction_currency, transaction_amount, direction = parse_icbc_currency_amount(transaction_amount_text)
    settlement_currency, settlement_amount, settlement_direction = parse_icbc_currency_amount(settlement_amount_text)
    if transaction_amount is None or settlement_amount is None:
        return None

    direction = settlement_direction or direction
    transaction_amount = apply_icbc_direction(transaction_amount, direction)
    settlement_amount = apply_icbc_direction(settlement_amount, direction)
    description = normalize_spaces(f"{transaction_type} {merchant}")

    return Transaction(
        bank="工商银行",
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
        confidence=0.96,
        raw_text=line,
    )


def parse_icbc_currency_amount(value: str) -> tuple[str, Decimal | None, str]:
    direction = ""
    direction_match = re.search(r"\((存入|支出)\)", value)
    if direction_match:
        direction = direction_match.group(1)

    clean_value = re.sub(r"\((存入|支出)\)", "", value).strip()
    match = re.match(r"^(.+?)/(RMB|CNY|USD)$", clean_value, flags=re.IGNORECASE)
    if not match:
        return "CNY", None, direction

    amount = parse_amount(match.group(1))
    return normalize_icbc_currency(match.group(2)), amount, direction


def normalize_icbc_currency(currency: str) -> str:
    upper = currency.upper()
    if upper in {"RMB", "CNY", "CHN"}:
        return "CNY"
    return upper


def apply_icbc_direction(amount: Decimal, direction: str) -> Decimal:
    if direction == "存入":
        return -abs(amount)
    if direction == "支出":
        return abs(amount)
    return amount
