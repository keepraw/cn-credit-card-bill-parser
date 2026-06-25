from __future__ import annotations

import shutil
from datetime import datetime
from pathlib import Path
import re

from .config import BACKUP_DIR, DB_PATH, INBOX_DIR, OUTPUT_DIR, PROCESSED_DIR, REVIEW_FILES_DIR, SUPPORTED_SUFFIXES
from .db import Database
from .dedupe import assign_ids
from .exporters import export_outputs
from .extractors import extract_source
from .models import ReviewItem
from .parsers.registry import parse_statement

PendingMove = tuple[Path, Path, str | None]


def ensure_directories() -> None:
    for directory in [INBOX_DIR, OUTPUT_DIR, PROCESSED_DIR, REVIEW_FILES_DIR, DB_PATH.parent, BACKUP_DIR]:
        directory.mkdir(parents=True, exist_ok=True)


def run() -> tuple[int, int, Path | None]:
    ensure_directories()
    backup_path = create_run_backup()
    db = Database(DB_PATH)
    review_items: list[ReviewItem] = []
    pending_moves: list[PendingMove] = []
    processed_count = 0
    inserted_count = 0

    try:
        with db.transaction():
            for path in sorted(INBOX_DIR.iterdir()):
                if not path.is_file() or path.suffix.lower() not in SUPPORTED_SUFFIXES:
                    continue

                file_review_items: list[ReviewItem] = []
                file_pending_moves: list[PendingMove] = []
                file_processed_count = 0
                file_inserted_count = 0

                try:
                    with db.transaction():
                        source = extract_source(path)
                        if db.file_processed(source.file_hash):
                            file_review_items.append(ReviewItem(
                                reason="duplicate_file",
                                source_file_name=source.file_name,
                                source_file_hash=source.file_hash,
                                detail="SHA256 already exists in database; file skipped.",
                            ))
                            file_pending_moves.append((path, PROCESSED_DIR, build_duplicate_name(path, source.file_hash)))
                            continue

                        if not source.text.strip():
                            file_review_items.append(ReviewItem(
                                reason="empty_text",
                                source_file_name=source.file_name,
                                source_file_hash=source.file_hash,
                                detail="No text extracted. If this is a scanned PDF, install optional OCR dependencies.",
                            ))
                            file_pending_moves.append((path, REVIEW_FILES_DIR, build_review_name(path, "no_text", source.file_hash)))
                            continue

                        statement = parse_statement(source)
                        key = assign_ids(statement)
                        db.upsert_statement(statement, key, source.file_hash, source.file_name, source.source_type)

                        for warning in statement.warnings:
                            file_review_items.append(ReviewItem(
                                reason=warning,
                                source_file_name=source.file_name,
                                source_file_hash=source.file_hash,
                                bank=statement.bank,
                                card_last4=statement.card_last4,
                                statement_key=key,
                                detail=f"Parser {statement.parser_name} confidence={statement.confidence}",
                            ))

                        for transaction in statement.transactions:
                            if transaction.confidence < 0.7:
                                file_review_items.append(ReviewItem(
                                    reason="low_confidence_transaction",
                                    source_file_name=source.file_name,
                                    source_file_hash=source.file_hash,
                                    bank=transaction.bank,
                                    card_last4=transaction.card_last4,
                                    transaction_id=transaction.transaction_id,
                                    statement_key=transaction.statement_key,
                                    detail=f"confidence={transaction.confidence}",
                                    raw_text=transaction.raw_text,
                                ))
                            if db.transaction_exists(transaction.transaction_id):
                                file_review_items.append(ReviewItem(
                                    reason="duplicate_transaction",
                                    source_file_name=source.file_name,
                                    source_file_hash=source.file_hash,
                                    bank=transaction.bank,
                                    card_last4=transaction.card_last4,
                                    transaction_id=transaction.transaction_id,
                                    statement_key=transaction.statement_key,
                                    detail="Transaction hash already exists; skipped from formal output.",
                                    raw_text=transaction.raw_text,
                                ))
                                continue
                            db.insert_transaction(transaction)
                            file_inserted_count += 1

                        db.mark_file_processed(source.file_hash, source.file_name, source.source_type)
                        file_pending_moves.append((path, PROCESSED_DIR, build_processed_name(path, statement, source.source_type, source.file_hash)))
                        file_processed_count = 1
                except Exception as exc:
                    file_review_items = [ReviewItem(
                        reason="file_processing_error",
                        source_file_name=path.name,
                        source_file_hash="",
                        detail=str(exc),
                    )]
                    file_pending_moves = [(path, REVIEW_FILES_DIR, build_review_name(path, "error", ""))]
                    file_processed_count = 0
                    file_inserted_count = 0

                review_items.extend(file_review_items)
                pending_moves.extend(file_pending_moves)
                processed_count += file_processed_count
                inserted_count += file_inserted_count

            export_outputs(OUTPUT_DIR, db.fetch_transactions(), review_items)

        for path, target_dir, new_name in pending_moves:
            if path.exists():
                move_file(path, target_dir, new_name)
        return processed_count, inserted_count, backup_path
    finally:
        db.close()


def create_run_backup() -> Path | None:
    backup_sources = [OUTPUT_DIR, PROCESSED_DIR, REVIEW_FILES_DIR, DB_PATH.parent]
    timestamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    backup_root = BACKUP_DIR / timestamp
    copied_any = False

    for source_dir in backup_sources:
        if not source_dir.exists():
            continue
        files = [path for path in source_dir.iterdir() if path.is_file() and path.name != ".gitkeep"]
        if not files:
            continue
        target_dir = backup_root / source_dir.name
        target_dir.mkdir(parents=True, exist_ok=True)
        for source_path in files:
            shutil.copy2(source_path, target_dir / source_path.name)
            copied_any = True

    if not copied_any:
        return None
    return backup_root


def move_file(path: Path, target_dir: Path, new_name: str | None = None) -> None:
    target_dir.mkdir(parents=True, exist_ok=True)
    target = target_dir / (new_name or path.name)
    if target.exists():
        stem = target.stem
        suffix = target.suffix
        index = 1
        while True:
            candidate = target_dir / f"{stem}_{index}{suffix}"
            if not candidate.exists():
                target = candidate
                break
            index += 1
    shutil.move(str(path), str(target))


def build_processed_name(path: Path, statement, source_type: str, file_hash: str) -> str:
    bank = statement.bank or "unknown-bank"
    card = statement.card_last4 or "unknown-card"
    statement_month = "unknown-month"
    if statement.statement_end:
        statement_month = f"{statement.statement_end:%Y%m}"
    elif statement.statement_start:
        statement_month = f"{statement.statement_start:%Y%m}"
    return "_".join([safe_filename(bank), safe_filename(card), statement_month]) + path.suffix.lower()


def build_duplicate_name(path: Path, file_hash: str) -> str:
    return "__".join(["duplicate", file_hash[:8], safe_filename(original_stem(path.stem))]) + path.suffix.lower()


def build_review_name(path: Path, reason: str, file_hash: str) -> str:
    timestamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    hash_part = file_hash[:8] if file_hash else "nohash"
    return "__".join([safe_filename(reason), timestamp, hash_part, safe_filename(original_stem(path.stem))]) + path.suffix.lower()


def safe_filename(value: object) -> str:
    text = str(value or "").strip()
    text = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", text)
    text = re.sub(r"\s+", "-", text)
    text = text.strip(" ._-")
    return text or "unknown"


def original_stem(stem: str) -> str:
    parts = stem.split("__")
    if parts and parts[0] in {"processed", "duplicate"} and len(parts) >= 7:
        return parts[-1]
    if parts and parts[0] in {"error", "no_text"} and len(parts) >= 4:
        return parts[-1]
    return stem
