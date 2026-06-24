from __future__ import annotations

import re
from datetime import date
from decimal import Decimal

from dateutil.relativedelta import relativedelta

from ccparser.models import ParsedStatement, SourceContext, Transaction
from ccparser.normalizers import extract_card_last4, normalize_spaces, parse_amount, parse_date

from .generic import parse_generic


def parse(context: SourceContext) -> ParsedStatement:
    if "人民币交易明细" in context.text or "RMB Transaction Detailed List" in context.text:
        statement = parse_boc_pdf(context)
        if statement.transactions:
            return statement
    return parse_generic(context, bank="中国银行", parser_name="boc")


def parse_boc_pdf(context: SourceContext) -> ParsedStatement:
    text = context.text
    card_last4 = extract_card_last4(text)
    statement_start, statement_end = extract_boc_period(text)
    transactions = extract_rmb_transactions_by_position(context, card_last4, (statement_end or date.today()).year)
    if not transactions:
        transactions = extract_rmb_transactions(context, card_last4, (statement_end or date.today()).year)
    warnings: list[str] = []
    if not card_last4:
        warnings.append("missing_card_last4")
    if not statement_start or not statement_end:
        warnings.append("missing_statement_period")
    if not transactions:
        warnings.append("no_transactions_found")

    return ParsedStatement(
        bank="中国银行",
        card_last4=card_last4,
        statement_start=statement_start,
        statement_end=statement_end,
        transactions=transactions,
        confidence=0.9 if transactions and card_last4 else 0.55,
        parser_name="boc_pdf",
        warnings=warnings,
    )


def extract_boc_period(text: str) -> tuple[date | None, date | None]:
    closing_date = None
    summary_match = re.search(r"Payment Due Date Statement Closing Date[\s\S]{0,120}?(\d{4}-\d{2}-\d{2})\s+(\d{4}-\d{2}-\d{2})", text)
    if summary_match:
        closing_date = parse_date(summary_match.group(2))
    if not closing_date:
        title_match = re.search(r"账单\((\d{4})年(\d{2})月\)", text)
        if title_match:
            year = int(title_match.group(1))
            month = int(title_match.group(2))
            closing_date = date(year, month, 1) + relativedelta(months=1, days=-1)
    if not closing_date:
        return None, None
    statement_start = closing_date - relativedelta(months=1) + relativedelta(days=1)
    return statement_start, closing_date


def extract_rmb_transactions(context: SourceContext, fallback_card_last4: str, default_year: int) -> list[Transaction]:
    lines = [normalize_spaces(line) for line in context.text.splitlines()]
    section = _slice_transaction_section(lines)
    transactions: list[Transaction] = []
    pending_description: list[str] = []

    for line in section:
        if _is_noise_line(line):
            continue
        if _apply_post_transaction_tail(line, transactions, pending_description):
            continue
        if _is_split_chn_marker(line, pending_description):
            pending_description[-1] = f"{pending_description[-1]}{line}"
            continue
        row = _parse_boc_transaction_line(line, pending_description, context, fallback_card_last4, default_year)
        if row:
            transactions.append(row)
            pending_description.clear()
            continue
        if _looks_like_description_continuation(line):
            pending_description.append(line)

    return transactions


def extract_rmb_transactions_by_position(context: SourceContext, fallback_card_last4: str, default_year: int) -> list[Transaction]:
    if context.path.suffix.lower() != ".pdf" or not context.path.exists():
        return []
    try:
        import pdfplumber
    except ImportError:
        return []

    transactions: list[Transaction] = []
    pending_description: list[str] = []
    active = False
    with pdfplumber.open(context.path) as pdf:
        for page in pdf.pages:
            words = page.extract_words(x_tolerance=2, y_tolerance=3, keep_blank_chars=False)
            if not words:
                continue
            rows = _group_words_by_row(words)
            deposit_x, expenditure_x = _find_amount_column_centers(words)
            for row_words in rows:
                row_text = normalize_spaces(" ".join(word["text"] for word in row_words))
                if "人民币交易明细" in row_text or "RMB Transaction Detailed List" in row_text:
                    active = True
                    pending_description.clear()
                    continue
                if not active:
                    continue
                if "积分奖励计划" in row_text or "Loyalty Plan" in row_text:
                    active = False
                    pending_description.clear()
                    continue
                if _is_noise_line(row_text):
                    continue
                if _apply_post_transaction_tail(row_text, transactions, pending_description):
                    continue

                row = _parse_boc_position_row(
                    row_words,
                    row_text,
                    pending_description,
                    context,
                    fallback_card_last4,
                    default_year,
                    deposit_x,
                    expenditure_x,
                )
                if row:
                    transactions.append(row)
                    pending_description.clear()
                    continue
                if _looks_like_description_continuation(row_text):
                    pending_description.append(row_text)

    return transactions


def _group_words_by_row(words: list[dict]) -> list[list[dict]]:
    rows: list[list[dict]] = []
    for word in sorted(words, key=lambda item: (round(item["top"] / 3) * 3, item["x0"])):
        if not rows or abs(rows[-1][0]["top"] - word["top"]) > 4:
            rows.append([word])
        else:
            rows[-1].append(word)
    return [sorted(row, key=lambda item: item["x0"]) for row in rows]


def _find_amount_column_centers(words: list[dict]) -> tuple[float | None, float | None]:
    deposit_candidates = [
        (word["x0"] + word["x1"]) / 2
        for word in words
        if word["text"] in {"存入", "Deposit"}
    ]
    expenditure_candidates = [
        (word["x0"] + word["x1"]) / 2
        for word in words
        if word["text"] in {"支出", "Expenditure"}
    ]
    deposit_x = sum(deposit_candidates) / len(deposit_candidates) if deposit_candidates else None
    expenditure_x = sum(expenditure_candidates) / len(expenditure_candidates) if expenditure_candidates else None
    return deposit_x, expenditure_x


def _parse_boc_position_row(
    row_words: list[dict],
    row_text: str,
    pending_description: list[str],
    context: SourceContext,
    fallback_card_last4: str,
    default_year: int,
    deposit_x: float | None,
    expenditure_x: float | None,
) -> Transaction | None:
    date_words = [word for word in row_words if re.fullmatch(r"\d{4}-\d{2}-\d{2}|\d{6}", word["text"])]
    if len(date_words) < 2:
        return None
    card_word = next((word for word in row_words if re.fullmatch(r"\d{4}", word["text"]) and word["x0"] > date_words[1]["x1"]), None)
    if not card_word:
        return None
    amount_words = [
        word for word in row_words
        if re.fullmatch(r"-?\d[\d,]*\.\d{2}", word["text"]) and word["x0"] > card_word["x1"]
    ]
    if not amount_words:
        return None
    amount_word = amount_words[-1]

    transaction_date = parse_date(date_words[0]["text"], default_year)
    posting_date = parse_date(date_words[1]["text"], default_year)
    if not transaction_date or not posting_date:
        return None

    inline_parts = [
        word["text"] for word in row_words
        if card_word["x1"] < word["x0"] < amount_word["x0"]
        and not re.fullmatch(r"-?\d[\d,]*\.\d{2}", word["text"])
    ]
    raw_description = normalize_spaces(" ".join([*pending_description, *inline_parts]))
    transaction_currency = _detect_boc_transaction_currency(raw_description)
    description = _clean_boc_description(raw_description)
    amount = parse_amount(amount_word["text"], description)
    if amount is None:
        return None
    amount = _apply_boc_column_sign(amount, amount_word, deposit_x, expenditure_x, description)

    return Transaction(
        bank="中国银行",
        card_last4=card_word["text"] or fallback_card_last4,
        transaction_date=transaction_date,
        posting_date=posting_date,
        description=description or "未识别交易",
        transaction_currency=transaction_currency,
        transaction_amount=amount,
        settlement_currency="CNY",
        settlement_amount=amount,
        source_file_name=context.file_name,
        source_file_hash=context.file_hash,
        confidence=0.96,
        raw_text=row_text,
    )


def _apply_boc_column_sign(amount: Decimal, amount_word: dict, deposit_x: float | None, expenditure_x: float | None, description: str) -> Decimal:
    if deposit_x is not None and expenditure_x is not None:
        amount_center = (amount_word["x0"] + amount_word["x1"]) / 2
        boundary = (deposit_x + expenditure_x) / 2
        if amount_center < boundary:
            return -abs(amount)
        return abs(amount)
    return _apply_boc_deposit_expenditure_sign(amount, description, has_pending_description=False)


def _slice_transaction_section(lines: list[str]) -> list[str]:
    start = None
    for index, line in enumerate(lines):
        if "人民币交易明细" in line or "RMB Transaction Detailed List" in line:
            start = index + 1
            break
    if start is None:
        return []

    end = len(lines)
    for index in range(start, len(lines)):
        line = lines[index]
        if "积分奖励计划" in line or "Loyalty Plan" in line or "第 2 页" in line:
            end = index
            break
    return lines[start:end]


def _parse_boc_transaction_line(
    line: str,
    pending_description: list[str],
    context: SourceContext,
    fallback_card_last4: str,
    default_year: int,
) -> Transaction | None:
    pattern = re.compile(
        r"^(?P<tran>\d{4}-\d{2}-\d{2}|\d{6})\s+"
        r"(?P<post>\d{4}-\d{2}-\d{2}|\d{6})\s+"
        r"(?P<card>\d{4})\s+"
        r"(?:(?P<body>.*?)\s+)?"
        r"(?P<amount>-?\d[\d,]*\.\d{2})(?:\s*)$"
    )
    match = pattern.match(line)
    if not match:
        return None

    transaction_date = parse_date(match.group("tran"), default_year)
    posting_date = parse_date(match.group("post"), default_year) or transaction_date
    if not transaction_date or not posting_date:
        return None

    inline_description = normalize_spaces(match.group("body") or "")
    description_parts = [*pending_description, inline_description]
    raw_description = normalize_spaces(" ".join(part for part in description_parts if part))
    transaction_currency = _detect_boc_transaction_currency(raw_description)
    description = _clean_boc_description(raw_description)
    amount = parse_amount(match.group("amount"), description)
    if amount is None:
        return None
    amount = _apply_boc_deposit_expenditure_sign(amount, description, has_pending_description=bool(pending_description))
    card_last4 = match.group("card") or fallback_card_last4

    return Transaction(
        bank="中国银行",
        card_last4=card_last4,
        transaction_date=transaction_date,
        posting_date=posting_date,
        description=description or "未识别交易",
        transaction_currency=transaction_currency,
        transaction_amount=amount,
        settlement_currency="CNY",
        settlement_amount=amount,
        source_file_name=context.file_name,
        source_file_hash=context.file_hash,
        confidence=0.9,
        raw_text=line,
    )


def _apply_boc_deposit_expenditure_sign(amount: Decimal, description: str, has_pending_description: bool) -> Decimal:
    if has_pending_description:
        return abs(amount)
    if any(keyword in description.upper() for keyword in ("BOCNET", "PAYMENT", "REPAY", "还款", "存入")):
        return -abs(amount)
    if re.search(r"[\u4e00-\u9fff]{2,4}$", description) and not any(marker in description for marker in ("-", "微信", "支付宝", "京东", "商城", "支付")):
        return -abs(amount)
    return amount


def _detect_boc_transaction_currency(description: str) -> str:
    upper = description.upper()
    if re.search(r"(?<![A-Z])CHN(?![A-Z])", upper):
        return "CNY"
    if re.search(r"[\u4e00-\u9fff]CHN$", upper):
        return "CNY"
    return "CNY"


def _clean_boc_description(description: str) -> str:
    text = normalize_spaces(description)
    text = re.sub(r"(?<![A-Z])C\s+HN(?![A-Z])", "", text, flags=re.IGNORECASE)
    text = re.sub(r"(?<![A-Z])CHN(?![A-Z])", "", text, flags=re.IGNORECASE)
    text = re.sub(r"([\u4e00-\u9fff])CHN$", r"\1", text, flags=re.IGNORECASE)
    if re.search(r"[\u4e00-\u9fff]", text):
        text = re.sub(r"C$", "", text)
    return normalize_spaces(text)


def _looks_like_description_continuation(line: str) -> bool:
    if not line or _is_noise_line(line):
        return False
    if re.match(r"^\d{4}-\d{2}-\d{2}\s+", line):
        return False
    if re.match(r"^\d+\s+", line):
        return False
    if re.fullmatch(r"[A-Z]{2,4}", line):
        return False
    return bool(re.search(r"[\u4e00-\u9fffA-Za-z]", line))


def _is_split_chn_marker(line: str, pending_description: list[str]) -> bool:
    return bool(line.upper() == "HN" and pending_description and pending_description[-1].upper().endswith("C"))


def _apply_post_transaction_tail(line: str, transactions: list[Transaction], pending_description: list[str]) -> bool:
    if not transactions or pending_description:
        return False
    if line.upper() == "HN" and transactions[-1].description.upper().endswith("C"):
        transactions[-1].description = _clean_boc_description(f"{transactions[-1].description}{line}")
        transactions[-1].transaction_currency = "CNY"
        return True
    if re.fullmatch(r"[\u4e00-\u9fff]{1,3}(?:CHN)?", line, flags=re.IGNORECASE):
        transactions[-1].description = _clean_boc_description(f"{transactions[-1].description}{line}")
        transactions[-1].transaction_currency = _detect_boc_transaction_currency(line)
        return True
    if re.fullmatch(r"[\u4e00-\u9fff]{1,3}", line):
        transactions[-1].description = _clean_boc_description(f"{transactions[-1].description}{line}")
        return True
    return False


def _is_noise_line(line: str) -> bool:
    if not line:
        return True
    noise_keywords = (
        "交易日",
        "银行记账日",
        "Transaction Date",
        "Posting Date",
        "Description",
        "Deposit",
        "Expenditure",
        "Digits",
        "of Card Number",
        "卡号后四位",
    )
    return any(keyword in line for keyword in noise_keywords)
