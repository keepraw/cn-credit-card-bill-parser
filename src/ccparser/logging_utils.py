from __future__ import annotations

import logging
from datetime import datetime
from pathlib import Path

from .config import LOG_DIR

LOG_FORMAT = "%(asctime)s %(levelname)s [%(name)s] %(message)s"
DATE_FORMAT = "%Y-%m-%d %H:%M:%S"
VALID_LOG_LEVELS = {"DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"}


def parse_log_level(value: str) -> int:
    normalized = value.upper()
    if normalized not in VALID_LOG_LEVELS:
        valid = ", ".join(sorted(VALID_LOG_LEVELS))
        raise ValueError(f"Invalid log level {value!r}. Choose one of: {valid}")
    return getattr(logging, normalized)


def configure_logging(level: int = logging.WARNING, log_dir: Path = LOG_DIR) -> Path:
    log_dir.mkdir(parents=True, exist_ok=True)
    run_log_dir = log_dir / "runs"
    run_log_dir.mkdir(parents=True, exist_ok=True)
    run_log_path = run_log_dir / f"{datetime.now():%Y%m%d-%H%M%S}.log"

    formatter = logging.Formatter(LOG_FORMAT, DATE_FORMAT)
    root = logging.getLogger()
    root.handlers.clear()
    root.setLevel(level)

    parser_log_handler = logging.FileHandler(log_dir / "parser.log", encoding="utf-8")
    parser_log_handler.setLevel(level)
    parser_log_handler.setFormatter(formatter)

    run_log_handler = logging.FileHandler(run_log_path, encoding="utf-8")
    run_log_handler.setLevel(level)
    run_log_handler.setFormatter(formatter)

    console_handler = logging.StreamHandler()
    console_handler.setLevel(logging.ERROR)
    console_handler.setFormatter(formatter)

    root.addHandler(parser_log_handler)
    root.addHandler(run_log_handler)
    root.addHandler(console_handler)
    logging.captureWarnings(True)

    logging.getLogger(__name__).debug("Logging configured at level %s", logging.getLevelName(level))
    return run_log_path
