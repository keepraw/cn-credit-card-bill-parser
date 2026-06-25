from __future__ import annotations

import re
from datetime import date, datetime
from decimal import Decimal, InvalidOperation


NEGATIVE_KEYWORDS = ("还款", "退货", "退款", "入账", "刷卡金", "返还", "返现", "冲正", "贷记")
POSITIVE_KEYWORDS = ("消费", "取现", "费用", "手续费", "利息", "支出", "借记")


def normalize_spaces(value: str) -> str:
    return re.sub(r"\s+", " ", value.replace("\u3000", " ")).strip()


def parse_date(value: object, default_year: int | None = None) -> date | None:
    if value is None:
        return None
    if isinstance(value, date) and not isinstance(value, datetime):
        return value
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, (int, float)) and value > 1000:
        try:
            return datetime(1899, 12, 30).date().fromordinal(datetime(1899, 12, 30).toordinal() + int(value))
        except (OverflowError, ValueError):
            return None

    text = str(value).strip()
    if not text:
        return None

    serial_match = re.fullmatch(r"\d{5}", text)
    if serial_match:
        return parse_date(int(text))

    six_digit = re.fullmatch(r"(\d{2})(\d{2})(\d{2})", text)
    if six_digit:
        year = 2000 + int(six_digit.group(1))
        return _safe_date(year, int(six_digit.group(2)), int(six_digit.group(3)))

    full = re.search(r"(\d{4})[年/\-.](\d{1,2})[月/\-.](\d{1,2})", text)
    if full:
        return _safe_date(int(full.group(1)), int(full.group(2)), int(full.group(3)))

    month_day = re.fullmatch(r"(\d{1,2})[月/\-.](\d{1,2})日?", text)
    if month_day and default_year:
        return _safe_date(default_year, int(month_day.group(1)), int(month_day.group(2)))

    compact = re.fullmatch(r"(\d{4})(\d{2})(\d{2})", text)
    if compact:
        return _safe_date(int(compact.group(1)), int(compact.group(2)), int(compact.group(3)))

    return None


def _safe_date(year: int, month: int, day: int) -> date | None:
    try:
        return date(year, month, day)
    except ValueError:
        return None


def parse_amount(value: object, description: str = "") -> Decimal | None:
    amount = parse_amount_raw(value)
    if amount is None:
        return None
    return apply_sign_by_description(amount, description)


def parse_amount_raw(value: object) -> Decimal | None:
    if value is None:
        return None
    text = str(value).strip()
    if not text:
        return None

    negative_by_format = bool(re.search(r"^\(.*\)$", text))
    credit_slash = bool(re.search(r"/\s*C\b", text, flags=re.IGNORECASE))
    text = re.sub(r"/\s*[CD]\b", "", text, flags=re.IGNORECASE)
    text = text.replace(",", "")
    text = re.sub(r"(人民币|￥|¥|RMB|CNY|USD|HKD|元)", "", text, flags=re.IGNORECASE)
    text = text.replace("(", "").replace(")", "").strip()
    match = re.search(r"[-+]?\d+(?:\.\d+)?", text)
    if not match:
        return None
    try:
        amount = Decimal(match.group(0))
    except InvalidOperation:
        return None

    if negative_by_format or credit_slash:
        return -abs(amount)
    return amount


def apply_sign_by_description(amount: Decimal, description: str) -> Decimal:
    desc = description or ""
    if any(keyword in desc for keyword in NEGATIVE_KEYWORDS):
        return -abs(amount)
    if any(keyword in desc for keyword in POSITIVE_KEYWORDS):
        return abs(amount)
    return amount


def resolve_amount_sign(
    amount: Decimal,
    *,
    direction_field: str = "",
    section: str = "",
    raw_text: str = "",
    description: str = "",
) -> Decimal:
    structured_text = normalize_spaces(f"{direction_field} {section}").lower()
    credit_terms = ("存入", "贷记", "还款", "退款", "退货", "返现", "返还", "入账", "credit", "deposit", "payment", "refund")
    debit_terms = ("支出", "借记", "消费", "取现", "费用", "debit", "expenditure", "purchase", "cash advance")

    if any(term in structured_text for term in credit_terms):
        return -abs(amount)
    if any(term in structured_text for term in debit_terms):
        return abs(amount)

    raw = str(raw_text or "")
    if re.search(r"^\s*\(.*\)\s*$", raw) or re.search(r"/\s*C\b", raw, flags=re.IGNORECASE):
        return -abs(amount)
    if re.search(r"/\s*D\b", raw, flags=re.IGNORECASE):
        return abs(amount)
    if amount < 0:
        return amount

    return apply_sign_by_description(amount, description)


def detect_currency(*values: object) -> str:
    text = " ".join(str(value or "") for value in values)
    upper = text.upper()
    if "USD" in upper or "美元" in text:
        return "USD"
    if "HKD" in upper or "港币" in text:
        return "HKD"
    if "EUR" in upper or "欧元" in text:
        return "EUR"
    if "JPY" in upper or "日元" in text:
        return "JPY"
    return "CNY"


def extract_card_last4(text: str) -> str:
    priority_patterns = [
        r"(?:卡号后四位|Last Four)[\s\S]{0,80}?(?:\*{2,}|\b)(\d{4})\b",
        r"(?:尾号|末四位)[^\d]{0,12}(\d{4})\b",
        r"卡号[：:\s]*(?:\d{0,12}\s*)?(?:[*xX-]+\s*)?(\d{4})\b",
        r"Credit Card No\.[\s\S]{0,80}?(?:\*{2,}|\b)(\d{4})\b",
    ]
    for pattern in priority_patterns:
        candidates = re.findall(pattern, text, flags=re.IGNORECASE)
        if candidates:
            return candidates[0]
    masked = re.findall(r"[*xX]{2,}\s*(\d{4})", text)
    return masked[0] if masked else ""


def extract_statement_period(text: str) -> tuple[date | None, date | None]:
    patterns = [
        r"(?:账单周期|账期|账单期间|周期)[:：\s]*(\d{4}[年/\-.]\d{1,2}[月/\-.]\d{1,2}日?)\s*(?:至|到|-|~)\s*(\d{4}[年/\-.]\d{1,2}[月/\-.]\d{1,2}日?)",
        r"(\d{4}[年/\-.]\d{1,2}[月/\-.]\d{1,2}日?)\s*(?:至|到|~)\s*(\d{4}[年/\-.]\d{1,2}[月/\-.]\d{1,2}日?)",
    ]
    for pattern in patterns:
        match = re.search(pattern, text)
        if match:
            return parse_date(match.group(1)), parse_date(match.group(2))
    return None, None
