from __future__ import annotations

import re
from datetime import date

from ccparser.models import ParsedStatement, SourceContext, Transaction
from ccparser.normalizers import (
    detect_currency,
    extract_card_last4,
    extract_statement_period,
    normalize_spaces,
    parse_amount,
    parse_date,
)


BANK_ALIASES = {
    "交通银行": ("交通银行", "BOCOM", "Bank of Communications"),
    "中国银行": ("中国银行", "BOC", "Bank of China"),
    "工商银行": ("工商银行", "ICBC", "中国工商银行"),
    "农业银行": ("农业银行", "ABC", "中国农业银行"),
}


NOISE_LINE_KEYWORDS = (
    "温馨提示",
    "友情提示",
    "客服",
    "客户服务",
    "积分",
    "活动",
    "权益",
    "广告",
    "分期",
    "手续费说明",
    "利息说明",
    "声明",
    "条款",
    "还款提醒",
    "最低还款",
    "到期还款",
    "如有疑问",
    "服务热线",
    "www.",
    "http://",
    "https://",
)


def detect_bank(text: str) -> str:
    for bank, aliases in BANK_ALIASES.items():
        if any(alias.lower() in text.lower() for alias in aliases):
            return bank
    return "未知银行"


def parse_generic(context: SourceContext, bank: str | None = None, parser_name: str = "generic") -> ParsedStatement:
    text = context.text
    parsed_bank = bank or detect_bank(text)
    card_last4 = extract_card_last4(text)
    statement_start, statement_end = extract_statement_period(text)
    default_year = (statement_end or statement_start or date.today()).year

    transactions: list[Transaction] = []
    for line in text.splitlines():
        normalized = normalize_spaces(line)
        if not normalized or _looks_like_header(normalized):
            continue
        if _looks_like_metadata(normalized):
            continue
        if _looks_like_noise(normalized):
            continue
        transaction = _parse_line(normalized, context, parsed_bank, card_last4, default_year)
        if transaction:
            transactions.append(transaction)

    confidence = 0.75 if parsed_bank != "未知银行" and card_last4 and transactions else 0.45
    warnings = []
    if not card_last4:
        warnings.append("missing_card_last4")
    if not statement_start or not statement_end:
        warnings.append("missing_statement_period")
    if not transactions:
        warnings.append("no_transactions_found")

    return ParsedStatement(
        bank=parsed_bank,
        card_last4=card_last4,
        statement_start=statement_start,
        statement_end=statement_end,
        transactions=transactions,
        confidence=confidence,
        parser_name=parser_name,
        warnings=warnings,
    )


def _looks_like_header(line: str) -> bool:
    header_words = ("交易日期", "入账日期", "记账日期", "交易说明", "摘要", "金额")
    return sum(1 for word in header_words if word in line) >= 2


def _looks_like_metadata(line: str) -> bool:
    metadata_words = ("账单周期", "账单期间", "账期", "到期还款日", "最低还款", "本期应还", "卡号尾号", "信用卡尾号")
    return any(word in line for word in metadata_words)


def _looks_like_noise(line: str) -> bool:
    return any(keyword.lower() in line.lower() for keyword in NOISE_LINE_KEYWORDS)


def _parse_line(line: str, context: SourceContext, bank: str, card_last4: str, default_year: int) -> Transaction | None:
    parts = [part.strip() for part in re.split(r"\s*\|\s*|\t+", line) if part.strip()]
    if len(parts) >= 4:
        return _parse_parts(parts, line, context, bank, card_last4, default_year)
    return _parse_free_text(line, context, bank, card_last4, default_year)


def _parse_parts(parts: list[str], raw_line: str, context: SourceContext, bank: str, card_last4: str, default_year: int) -> Transaction | None:
    dates: list[date] = []
    date_indexes: list[int] = []
    for index, part in enumerate(parts[:4]):
        parsed = parse_date(part, default_year)
        if parsed:
            dates.append(parsed)
            date_indexes.append(index)
    if not dates:
        return None

    amount_index = None
    amount = None
    for index in range(len(parts) - 1, -1, -1):
        parsed_amount = parse_amount(parts[index], raw_line)
        if parsed_amount is not None:
            amount_index = index
            amount = parsed_amount
            break
    if amount is None or amount_index is None:
        return None

    description_parts = [
        part for index, part in enumerate(parts)
        if index not in date_indexes and index != amount_index and not _currency_only(part)
    ]
    description = normalize_spaces(" ".join(description_parts)) or "未识别交易"
    transaction_date = dates[0]
    posting_date = dates[1] if len(dates) > 1 else transaction_date
    currency = detect_currency(raw_line)
    confidence = _transaction_evidence_score(
        raw_line,
        has_card=bool(card_last4),
        structured_columns=True,
        date_count=len(dates),
        has_amount=True,
        description=description,
    )

    return Transaction(
        bank=bank,
        card_last4=card_last4,
        transaction_date=transaction_date,
        posting_date=posting_date,
        description=description,
        transaction_currency=currency,
        transaction_amount=amount,
        settlement_currency=currency,
        settlement_amount=amount,
        source_file_name=context.file_name,
        source_file_hash=context.file_hash,
        confidence=confidence,
        raw_text=raw_line,
    )


def _parse_free_text(line: str, context: SourceContext, bank: str, card_last4: str, default_year: int) -> Transaction | None:
    date_matches = list(re.finditer(r"\d{4}[年/\-.]\d{1,2}[月/\-.]\d{1,2}日?|\b\d{6}\b|\b\d{1,2}[月/\-.]\d{1,2}日?\b", line))
    if not date_matches:
        return None
    amount_matches = list(re.finditer(r"\(?[-+]?(?:￥|¥|RMB|CNY)?\s*\d[\d,]*(?:\.\d{1,2})?\)?(?:/\s*[CD])?", line, flags=re.IGNORECASE))
    if not amount_matches:
        return None
    transaction_date = parse_date(date_matches[0].group(0), default_year)
    if not transaction_date:
        return None
    posting_date = parse_date(date_matches[1].group(0), default_year) if len(date_matches) > 1 else transaction_date
    posting_date = posting_date or transaction_date
    amount_text = amount_matches[-1].group(0)
    amount = parse_amount(amount_text, line)
    if amount is None:
        return None
    description = line
    for match in reversed(date_matches):
        description = description[:match.start()] + " " + description[match.end():]
    description = description.replace(amount_text, " ")
    description = normalize_spaces(description) or "未识别交易"
    currency = detect_currency(line)
    return Transaction(
        bank=bank,
        card_last4=card_last4,
        transaction_date=transaction_date,
        posting_date=posting_date,
        description=description,
        transaction_currency=currency,
        transaction_amount=amount,
        settlement_currency=currency,
        settlement_amount=amount,
        source_file_name=context.file_name,
        source_file_hash=context.file_hash,
        confidence=_transaction_evidence_score(
            line,
            has_card=bool(card_last4),
            structured_columns=False,
            date_count=len(date_matches),
            has_amount=True,
            description=description,
        ),
        raw_text=line,
    )


def _currency_only(value: str) -> bool:
    return value.upper() in {"CNY", "RMB", "USD", "HKD", "EUR", "JPY", "人民币", "美元", "港币"}


def _transaction_evidence_score(
    line: str,
    *,
    has_card: bool,
    structured_columns: bool,
    date_count: int,
    has_amount: bool,
    description: str,
) -> float:
    if _looks_like_noise(line):
        return 0.2

    score = 0.35
    if date_count >= 2:
        score += 0.2
    elif date_count == 1:
        score += 0.1
    if has_amount:
        score += 0.15
    if has_card:
        score += 0.15
    if structured_columns:
        score += 0.15
    if description and description != "未识别交易":
        score += 0.05
    return min(score, 0.98)
