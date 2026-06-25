from __future__ import annotations

from pathlib import Path


PROJECT_ROOT = Path.cwd()
INBOX_DIR = PROJECT_ROOT / "inbox"
OUTPUT_DIR = PROJECT_ROOT / "output"
PROCESSED_DIR = PROJECT_ROOT / "processed"
REVIEW_FILES_DIR = PROJECT_ROOT / "review_files"
DATA_DIR = PROJECT_ROOT / "data"
DB_PATH = DATA_DIR / "statements.db"
BACKUP_DIR = PROJECT_ROOT / "backups"

SUPPORTED_SUFFIXES = {".eml", ".pdf", ".html", ".htm", ".txt", ".csv", ".xlsx"}

SOURCE_PRIORITY = {
    "email_html": 40,
    "pdf_text": 30,
    "copied_text": 20,
    "ocr_pdf": 10,
}
