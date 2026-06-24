from __future__ import annotations

import re
from datetime import date
from decimal import Decimal

from ccparser.models import ParsedStatement, SourceContext, Transaction
from ccparser.normalizers import normalize_spaces, parse_amount, parse_date

from .generic import parse_generic


def parse(context: SourceContext) -> ParsedStatement:
    if "交通银行个人信用卡" in context.text and "账单周期" in context.text:
        statement = parse_bocom_email(context)
        if statement.transactions:
            return statement
    return parse_generic(context, bank="交通银行", parser_name="bocom")


def parse_bocom_email(context: SourceContext) -> ParsedStatement:
    statement_start, statement_end = extract_bocom_period(context.text)
    transactions = extract_bocom_transactions(context, statement_start, statement_end)
    card_last4 = transactions[0].card_last4 if transactions else extract_bocom_card_last4(context.text)

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
        bank="交通银行",
        card_last4=card_last4,
        statement_start=statement_start,
        statement_end=statement_end,
        transactions=transactions,
        confidence=0.93 if transactions and statement_start and statement_end else 0.55,
        parser_name="bocom_email",
        warnings=warnings,
    )


def extract_bocom_period(text: str) -> tuple[date | None, date | None]:
    match = re.search(
        r"账单周期\s*Statement Cycle\s*\|?\s*(\d{4}/\d{1,2}/\d{1,2})\s*-\s*(\d{4}/\d{1,2}/\d{1,2})",
        text,
    )
    if match:
        return parse_date(match.group(1)), parse_date(match.group(2))
    match = re.search(r"(\d{4}/\d{1,2}/\d{1,2})\s*-\s*(\d{4}/\d{1,2}/\d{1,2})", text)
    if match:
        return parse_date(match.group(1)), parse_date(match.group(2))
    return None, None


def extract_bocom_card_last4(text: str) -> str:
    match = re.search(r"交通银行个人信用卡\s+\d{6}\*+(\d{4})", text)
    if match:
        return match.group(1)
    match = re.search(r"\|\s*(\d{1,2}/\d{1,2})\s*\|\s*\d{1,2}/\d{1,2}\s*\|\s*(\d{4})\s*\|", text)
    return match.group(2) if match else ""


def extract_bocom_transactions(
    context: SourceContext,
    statement_start: date | None,
    statement_end: date | None,
) -> list[Transaction]:
    transactions: list[Transaction] = []
    section: str | None = None
    for line in context.text.splitlines():
        normalized = normalize_spaces(line)
        if "还款、退货、费用返还明细" in normalized:
            section = "credit"
            continue
        if "消费、取现、其他费用明细" in normalized:
            section = "debit"
            continue
        if "除以上账单显示交易外" in normalized or "温馨提示" in normalized:
            section = None
        if section not in {"credit", "debit"}:
            continue
        transaction = parse_bocom_transaction_line(normalized, context, section, statement_start, statement_end)
        if transaction:
            transactions.append(transaction)
    return transactions


def parse_bocom_transaction_line(
    line: str,
    context: SourceContext,
    section: str,
    statement_start: date | None,
    statement_end: date | None,
) -> Transaction | None:
    parts = [part.strip() for part in line.split("|")]
    parts = [part for part in parts if part]
    if len(parts) != 6:
        return None
    transaction_date = parse_bocom_month_day(parts[0], statement_start, statement_end)
    posting_date = parse_bocom_month_day(parts[1], statement_start, statement_end)
    if not transaction_date or not posting_date:
        return None
    card_last4 = parts[2]
    if not re.fullmatch(r"\d{4}", card_last4):
        return None
    description = normalize_spaces(parts[3])
    transaction_currency, transaction_amount = parse_bocom_currency_amount(parts[4], section)
    settlement_currency, settlement_amount = parse_bocom_currency_amount(parts[5], section)
    if transaction_amount is None or settlement_amount is None:
        return None

    return Transaction(
        bank="交通银行",
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


def parse_bocom_month_day(value: str, statement_start: date | None, statement_end: date | None) -> date | None:
    match = re.fullmatch(r"(\d{1,2})/(\d{1,2})", value.strip())
    if not match:
        return parse_date(value)
    month = int(match.group(1))
    day = int(match.group(2))
    candidate_years = []
    if statement_start:
        candidate_years.append(statement_start.year)
    if statement_end and statement_end.year not in candidate_years:
        candidate_years.append(statement_end.year)
    for year in candidate_years:
        parsed = parse_date(f"{year}/{month}/{day}")
        if parsed and statement_start and statement_end and statement_start <= parsed <= statement_end:
            return parsed
    year = statement_end.year if statement_end else date.today().year
    return parse_date(f"{year}/{month}/{day}")


def parse_bocom_currency_amount(value: str, section: str) -> tuple[str, Decimal | None]:
    match = re.match(r"^([A-Z]{3}|RMB|CNY|USD)\s+(.+)$", value.strip(), flags=re.IGNORECASE)
    if not match:
        return "CNY", None
    currency = normalize_bocom_currency(match.group(1))
    amount = parse_amount(match.group(2))
    if amount is None:
        return currency, None
    if section == "credit":
        amount = -abs(amount)
    elif section == "debit":
        amount = abs(amount)
    return currency, amount


def normalize_bocom_currency(currency: str) -> str:
    upper = currency.upper()
    if upper in {"RMB", "CNY", "CHN"}:
        return "CNY"
    return upper
