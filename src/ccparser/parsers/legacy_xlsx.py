from __future__ import annotations

from datetime import date
from decimal import Decimal
from typing import Any

from ccparser.models import ParsedStatement, SourceContext, Transaction
from ccparser.normalizers import normalize_spaces, parse_amount, parse_date

REQUIRED_COLUMNS = {
    "银行名称",
    "卡号",
    "交易日期",
    "入账日期",
    "交易详情",
    "交易币种",
    "交易金额",
    "入账币种",
    "入账金额",
}


def parse(context: SourceContext) -> ParsedStatement:
    try:
        import pandas as pd
    except ImportError as exc:
        raise RuntimeError("pandas/openpyxl is required to import historical XLSX files") from exc

    with pd.ExcelFile(context.path) as workbook:
        sheet_name = "统一账单" if "统一账单" in workbook.sheet_names else workbook.sheet_names[0]
        frame = pd.read_excel(workbook, sheet_name=sheet_name)
    frame.columns = [normalize_header(column) for column in frame.columns]
    missing = REQUIRED_COLUMNS - set(frame.columns)
    if missing:
        return ParsedStatement(
            bank="历史导入",
            card_last4="multi",
            statement_start=None,
            statement_end=None,
            transactions=[],
            confidence=0.1,
            parser_name="legacy_xlsx",
            warnings=[f"missing_columns:{','.join(sorted(missing))}"],
        )

    transactions: list[Transaction] = []
    for index, row in frame.iterrows():
        transaction = parse_row(context, row.to_dict(), index + 2)
        if transaction:
            transactions.append(transaction)

    dates = [transaction.transaction_date for transaction in transactions]
    statement_start = min(dates) if dates else None
    statement_end = max(dates) if dates else None
    banks = {transaction.bank for transaction in transactions}
    cards = {transaction.card_last4 for transaction in transactions}

    return ParsedStatement(
        bank="历史导入" if len(banks) != 1 else next(iter(banks)),
        card_last4="multi" if len(cards) != 1 else next(iter(cards)),
        statement_start=statement_start,
        statement_end=statement_end,
        transactions=transactions,
        confidence=0.98 if transactions else 0.2,
        parser_name="legacy_xlsx",
        warnings=[] if transactions else ["no_transactions_found"],
    )


def parse_row(context: SourceContext, row: dict[str, Any], excel_row_number: int) -> Transaction | None:
    bank = normalize_spaces(str(row.get("银行名称", "")))
    card_last4 = normalize_card(row.get("卡号"))
    transaction_date = parse_legacy_bill_date(row.get("交易日期"))
    posting_date = parse_legacy_bill_date(row.get("入账日期")) or transaction_date
    description = normalize_spaces(str(row.get("交易详情", "")))
    transaction_currency = normalize_currency(row.get("交易币种"))
    settlement_currency = normalize_currency(row.get("入账币种"))
    transaction_amount = parse_legacy_amount(row.get("交易金额"))
    settlement_amount = parse_legacy_amount(row.get("入账金额"))

    if not bank or not transaction_date or not posting_date or not description:
        return None
    if transaction_amount is None or settlement_amount is None:
        return None

    return Transaction(
        bank=bank,
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
        confidence=0.98,
        raw_text=f"xlsx row {excel_row_number}: {bank}|{card_last4}|{transaction_date}|{posting_date}|{description}|{transaction_currency} {transaction_amount}|{settlement_currency} {settlement_amount}",
    )


def normalize_header(value: object) -> str:
    return str(value).replace("\xa0", "").strip()


def normalize_card(value: object) -> str:
    if value is None:
        return "unknown"
    text = str(value).strip()
    if text.endswith(".0"):
        text = text[:-2]
    digits = "".join(char for char in text if char.isdigit())
    if not digits:
        return "unknown"
    return digits[-4:].zfill(4)


def normalize_currency(value: object) -> str:
    text = normalize_spaces(str(value or "")).upper()
    if text in {"RMB", "CNY", "CHN", "人民币"}:
        return "CNY"
    return text or "CNY"


def parse_legacy_amount(value: object) -> Decimal | None:
    if value is None:
        return None
    if isinstance(value, Decimal):
        return value
    return parse_amount(value)

def parse_legacy_bill_date(value: object, today: date | None = None) -> date | None:
    parsed = parse_date(value)
    if not parsed:
        return None

    reference = today or date.today()
    while parsed > reference:
        shifted = shift_year(parsed, -1)
        if not shifted or shifted == parsed:
            break
        parsed = shifted
    return parsed


def shift_year(value: date, years: int) -> date | None:
    try:
        return value.replace(year=value.year + years)
    except ValueError:
        if value.month == 2 and value.day == 29:
            return date(value.year + years, 2, 28)
        return None
