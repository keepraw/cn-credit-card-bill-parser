from __future__ import annotations

import re
from collections import Counter
from pathlib import Path

from .config import INBOX_DIR, OUTPUT_DIR, SUPPORTED_SUFFIXES
from .extractors import extract_source
from .normalizers import normalize_spaces
from .parsers.generic import detect_bank


MAX_SAMPLE_LINES = 80


def profile_inbox() -> Path:
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    report_path = OUTPUT_DIR / "format_profile.md"
    sections: list[str] = ["# Format Profile", ""]
    files = [path for path in sorted(INBOX_DIR.iterdir()) if path.is_file() and path.suffix.lower() in SUPPORTED_SUFFIXES]

    if not files:
        sections.extend([
            "No supported files found in `inbox/`.",
            "",
            "Put `.eml`, `.pdf`, `.html`, `.txt`, `.csv`, or `.xlsx` files into `inbox/`, then run profile mode again.",
        ])
        report_path.write_text("\n".join(sections), encoding="utf-8")
        return report_path

    for path in files:
        sections.extend(profile_file(path))
        sections.append("")

    report_path.write_text("\n".join(sections), encoding="utf-8")
    return report_path


def profile_file(path: Path) -> list[str]:
    try:
        source = extract_source(path)
        lines = [normalize_spaces(line) for line in source.text.splitlines()]
        lines = [line for line in lines if line]
    except Exception as exc:
        return [
            f"## `{path.name}`",
            "",
            f"- Status: extract failed",
            f"- Error: `{type(exc).__name__}: {exc}`",
        ]

    bank = detect_bank(source.text)
    table_like = [line for line in lines if "|" in line]
    date_like = [line for line in lines if re.search(r"\d{4}[年/\-.]\d{1,2}[月/\-.]\d{1,2}|\b\d{6}\b", line)]
    amount_like = [line for line in lines if re.search(r"(￥|¥|RMB|CNY|\d[\d,]*\.\d{2}|/\s*[CD]\b)", line, re.IGNORECASE)]
    separators = Counter(_separator_shape(line) for line in lines[:300])

    section = [
        f"## `{path.name}`",
        "",
        f"- Source type: `{source.source_type}`",
        f"- SHA256 prefix: `{source.file_hash[:12]}`",
        f"- Detected bank: `{bank}`",
        f"- Non-empty text lines: `{len(lines)}`",
        f"- Table-like lines containing `|`: `{len(table_like)}`",
        f"- Date-like lines: `{len(date_like)}`",
        f"- Amount-like lines: `{len(amount_like)}`",
        "",
        "### Common line shapes",
        "",
    ]
    for shape, count in separators.most_common(10):
        section.append(f"- `{shape}`: {count}")

    section.extend([
        "",
        "### Redacted sample lines",
        "",
        "```text",
    ])
    for line in _representative_lines(lines):
        section.append(redact_line(line))
    section.append("```")
    return section


def redact_line(line: str) -> str:
    text = line
    text = re.sub(r"(?<!\d)\d{12,19}(?!\d)", "[CARD_OR_LONG_NUMBER]", text)
    text = re.sub(r"([*xX-]{4,}\s*)\d{4}", r"\1[LAST4]", text)
    text = re.sub(r"(尾号|末四位|卡号|信用卡)([^\d]{0,8})\d{4}", r"\1\2[LAST4]", text)
    text = re.sub(r"(?<!\d)(?:￥|¥|RMB|CNY)?\s*-?\d{1,3}(?:,\d{3})*(?:\.\d{2})(?:/\s*[CD])?(?!\d)", "[AMOUNT]", text, flags=re.IGNORECASE)
    text = re.sub(r"(?<!\d)-?\d+\.\d{2}(?:/\s*[CD])?(?!\d)", "[AMOUNT]", text, flags=re.IGNORECASE)
    text = re.sub(r"(?<!\d)\d{4}[年/\-.]\d{1,2}[月/\-.]\d{1,2}日?(?!\d)", "[DATE]", text)
    text = re.sub(r"(?<!\d)\d{6}(?!\d)", "[YYMMDD]", text)
    return text[:240]


def _representative_lines(lines: list[str]) -> list[str]:
    selected: list[str] = []
    for predicate in [
        lambda line: "交易日期" in line or "入账日期" in line or "记账日期" in line,
        lambda line: "|" in line and re.search(r"\d", line),
        lambda line: re.search(r"\d{4}[年/\-.]\d{1,2}[月/\-.]\d{1,2}|\b\d{6}\b", line),
        lambda line: re.search(r"(￥|¥|RMB|CNY|\d[\d,]*\.\d{2}|/\s*[CD]\b)", line, re.IGNORECASE),
    ]:
        for line in lines:
            if predicate(line) and line not in selected:
                selected.append(line)
            if len(selected) >= MAX_SAMPLE_LINES:
                return selected
    if not selected:
        selected = lines[:MAX_SAMPLE_LINES]
    return selected[:MAX_SAMPLE_LINES]


def _separator_shape(line: str) -> str:
    if "|" in line:
        return f"pipe_columns_{line.count('|') + 1}"
    if "\t" in line:
        return f"tab_columns_{line.count(chr(9)) + 1}"
    runs = len(re.findall(r"\s{2,}", line))
    if runs:
        return f"space_runs_{runs + 1}"
    return "plain_line"
