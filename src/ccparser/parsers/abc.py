from __future__ import annotations

import re

from ccparser.models import ParsedStatement, SourceContext, Transaction
from ccparser.normalizers import normalize_spaces, parse_amount, parse_date

from .generic import parse_generic


def parse(context: SourceContext) -> ParsedStatement:
    if "中国农业银行" in context.text or "金穗信用卡" in context.text or "交易日期 T Date" in context.text:
        statement = parse_abc_email(context)
        if statement.transactions:
            return statement
    return parse_generic(context, bank="农业银行", parser_name="abc")


def parse_abc_email(context: SourceContext) -> ParsedStatement:
    statement_start, statement_end = extract_abc_period(context.text)
    transactions = extract_abc_transactions(context, statement_end.year if statement_end else None)
    card_last4 = transactions[0].card_last4 if transactions else extract_abc_card_last4(context.text)

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
        bank="农业银行",
        card_last4=card_last4,
        statement_start=statement_start,
        statement_end=statement_end,
        transactions=transactions,
        confidence=0.95 if transactions and statement_start and statement_end else 0.55,
        parser_name="abc_email",
        warnings=warnings,
    )


def extract_abc_period(text: str):
    match = re.search(
        r"账单周期\s*Statement Cycle\s*\|?\s*(\d{4}/\d{1,2}/\d{1,2})\s*-\s*(\d{4}/\d{1,2}/\d{1,2})",
        text,
    )
    if match:
        return parse_date(match.group(1)), parse_date(match.group(2))
    return None, None


def extract_abc_card_last4(text: str) -> str:
    match = re.search(r"卡号\s*Card No\s*\|\s*\d{6}\*+(\d{4})", text)
    if match:
        return match.group(1)
    match = re.search(r"\b(\d{4})\s*\|\s*[^|]+\|\s*[-\d,.]+/CNY", text)
    return match.group(1) if match else ""


def extract_abc_transactions(context: SourceContext, default_year: int | None) -> list[Transaction]:
    transactions: list[Transaction] = []
    active = False
    for line in context.text.splitlines():
        normalized = normalize_spaces(line)
        if "交易明细" in normalized:
            active = True
            continue
        if active and ("积分统计" in normalized or "刷卡金统计" in normalized or "温馨提示" in normalized):
            active = False
        if not active:
            continue
        transaction = parse_abc_transaction_line(normalized, context, default_year)
        if transaction:
            transactions.append(transaction)
    return transactions


def parse_abc_transaction_line(line: str, context: SourceContext, default_year: int | None) -> Transaction | None:
    parts = [part.strip() for part in line.split("|")]
    parts = [part for part in parts if part]
    if len(parts) != 6:
        return None

    transaction_date_text, posting_date_text, card_last4, description, transaction_amount_text, settlement_amount_text = parts
    if not re.fullmatch(r"\d{4}", card_last4):
        return None

    transaction_date = parse_date(transaction_date_text, default_year)
    posting_date = parse_date(posting_date_text, default_year)
    if not transaction_date or not posting_date:
        return None

    transaction_currency, transaction_amount = parse_abc_currency_amount(transaction_amount_text, description)
    settlement_currency, settlement_amount = parse_abc_currency_amount(settlement_amount_text, description)
    if transaction_amount is None or settlement_amount is None:
        return None

    transaction_amount = apply_abc_direction(transaction_amount, settlement_amount_text, description)
    settlement_amount = apply_abc_direction(settlement_amount, settlement_amount_text, description)

    return Transaction(
        bank="农业银行",
        card_last4=card_last4,
        transaction_date=transaction_date,
        posting_date=posting_date,
        description=normalize_spaces(description),
        transaction_currency=transaction_currency,
        transaction_amount=transaction_amount,
        settlement_currency=settlement_currency,
        settlement_amount=settlement_amount,
        source_file_name=context.file_name,
        source_file_hash=context.file_hash,
        confidence=0.96,
        raw_text=line,
    )


def parse_abc_currency_amount(value: str, description: str):
    match = re.match(r"^(.+?)/(CNY|RMB|USD)$", value.strip(), flags=re.IGNORECASE)
    if not match:
        return "CNY", None
    amount = parse_amount(match.group(1), description)
    return normalize_abc_currency(match.group(2)), amount


def normalize_abc_currency(currency: str) -> str:
    upper = currency.upper()
    if upper in {"RMB", "CNY", "CHN"}:
        return "CNY"
    return upper


def apply_abc_direction(amount, settlement_amount_text: str, description: str):
    desc = description or ""
    if any(keyword in desc for keyword in ("卡卡转账", "银联入账", "还款", "退货", "退款", "刷卡金", "返还", "返现", "入账")):
        return -abs(amount)
    if settlement_amount_text.strip().startswith("-"):
        return abs(amount)
    return amount
