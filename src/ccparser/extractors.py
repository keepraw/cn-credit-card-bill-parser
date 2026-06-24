from __future__ import annotations

import csv
import re
import warnings
from email import policy
from email.parser import BytesParser
from html import unescape
from pathlib import Path

from .hash_utils import file_sha256
from .models import SourceContext
from .normalizers import normalize_spaces


def extract_source(path: Path) -> SourceContext:
    suffix = path.suffix.lower()
    file_hash = file_sha256(path)
    if suffix == ".eml":
        source_type, text = extract_eml(path)
    elif suffix in {".html", ".htm"}:
        source_type, text = "email_html", extract_html(path.read_text(encoding="utf-8", errors="ignore"))
    elif suffix == ".pdf":
        source_type, text = extract_pdf_text(path)
    elif suffix == ".csv":
        source_type, text = "copied_text", extract_csv(path)
    elif suffix == ".xlsx":
        source_type, text = "copied_text", extract_xlsx(path)
    else:
        source_type, text = "copied_text", path.read_text(encoding="utf-8", errors="ignore")
    return SourceContext(path=path, file_name=path.name, file_hash=file_hash, source_type=source_type, text=text)


def extract_eml(path: Path) -> tuple[str, str]:
    message = BytesParser(policy=policy.default).parsebytes(path.read_bytes())
    html_parts: list[str] = []
    text_parts: list[str] = []
    if message.is_multipart():
        for part in message.walk():
            content_type = part.get_content_type()
            if content_type == "text/html":
                html_parts.append(str(part.get_content()))
            elif content_type == "text/plain":
                text_parts.append(str(part.get_content()))
    else:
        content_type = message.get_content_type()
        if content_type == "text/html":
            html_parts.append(str(message.get_content()))
        else:
            text_parts.append(str(message.get_content()))

    if html_parts:
        return "email_html", "\n".join(extract_html(part) for part in html_parts)
    return "copied_text", "\n".join(text_parts)


def extract_html(html: str) -> str:
    try:
        from bs4 import BeautifulSoup, XMLParsedAsHTMLWarning
    except ImportError:
        text = re.sub(r"(?is)<(script|style).*?>.*?</\1>", " ", html)
        text = re.sub(r"(?i)</tr>", "\n", text)
        text = re.sub(r"(?i)</t[dh]>", " | ", text)
        text = re.sub(r"(?s)<.*?>", " ", text)
        return "\n".join(normalize_spaces(line.strip(" |")) for line in unescape(text).splitlines() if normalize_spaces(line.strip(" |")))

    warnings.filterwarnings("ignore", category=XMLParsedAsHTMLWarning)
    soup = BeautifulSoup(html, "lxml")
    for tag in soup(["script", "style"]):
        tag.decompose()
    rows: list[str] = []
    for table_row in soup.find_all("tr"):
        cells = [normalize_spaces(cell.get_text(" ", strip=True)) for cell in table_row.find_all(["th", "td"])]
        if cells:
            rows.append(" | ".join(cells))
    for table in soup.find_all("table"):
        table.decompose()
    body_text = soup.get_text("\n", strip=True)
    return "\n".join(rows + [body_text])


def extract_pdf_text(path: Path) -> tuple[str, str]:
    try:
        import pdfplumber
    except ImportError as exc:
        raise RuntimeError("pdfplumber is required to parse PDF files. Run: pip install -r requirements.txt") from exc

    chunks: list[str] = []
    with pdfplumber.open(path) as pdf:
        for page in pdf.pages:
            text = page.extract_text() or ""
            if text.strip():
                chunks.append(text)
    if chunks:
        return "pdf_text", "\n".join(chunks)
    return "ocr_pdf", extract_pdf_ocr_optional(path)


def extract_pdf_ocr_optional(path: Path) -> str:
    try:
        import pytesseract
        from pdf2image import convert_from_path
    except ImportError:
        return ""

    texts: list[str] = []
    for image in convert_from_path(path):
        texts.append(pytesseract.image_to_string(image, lang="chi_sim+eng"))
    return "\n".join(texts)


def extract_csv(path: Path) -> str:
    rows: list[str] = []
    with path.open("r", encoding="utf-8-sig", errors="ignore", newline="") as file:
        reader = csv.reader(file)
        for row in reader:
            rows.append(" | ".join(str(cell) for cell in row))
    return "\n".join(rows)


def extract_xlsx(path: Path) -> str:
    try:
        import pandas as pd
    except ImportError as exc:
        raise RuntimeError("pandas and openpyxl are required to parse Excel files. Run: pip install -r requirements.txt") from exc

    frames = pd.read_excel(path, sheet_name=None, dtype=str)
    rows: list[str] = []
    for sheet_name, frame in frames.items():
        rows.append(f"Sheet: {sheet_name}")
        for row in frame.fillna("").astype(str).values.tolist():
            rows.append(" | ".join(row))
    return "\n".join(rows)
