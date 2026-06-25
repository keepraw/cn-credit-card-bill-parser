from __future__ import annotations

import argparse
import logging

from .logging_utils import configure_logging, parse_log_level
from .pipeline import ensure_directories, run
from .profiler import profile_inbox

logger = logging.getLogger(__name__)


def main() -> None:
    parser = argparse.ArgumentParser(description="cn-credit-card-bill-parser: local Chinese credit card bill parser")
    parser.add_argument(
        "--profile",
        action="store_true",
        help="Only inspect inbox file formats and write a redacted report; do not import transactions.",
    )
    parser.add_argument(
        "--debug",
        action="store_true",
        help="Write DEBUG-level diagnostic logs to logs/parser.log and logs/runs/.",
    )
    parser.add_argument(
        "--log-level",
        default="WARNING",
        help="Log level for file logs: DEBUG, INFO, WARNING, ERROR, or CRITICAL. Default: WARNING.",
    )
    args = parser.parse_args()

    try:
        log_level = logging.DEBUG if args.debug else parse_log_level(args.log_level)
    except ValueError as exc:
        parser.error(str(exc))

    run_log_path = configure_logging(log_level)
    logger.warning("Run started: profile=%s debug=%s log_level=%s run_log=%s", args.profile, args.debug, logging.getLevelName(log_level), run_log_path)

    try:
        ensure_directories()
        if args.profile:
            report_path = profile_inbox()
            logger.warning("Format profile written: %s", report_path)
            print(f"Format profile written to: {report_path}")
            print(f"Log: {run_log_path}")
            return

        processed_count, inserted_count, backup_path = run()
        logger.warning(
            "Run completed: processed_files=%s inserted_transactions=%s backup=%s",
            processed_count,
            inserted_count,
            backup_path or "none",
        )
        print(f"Processed files: {processed_count}")
        print(f"Inserted transactions: {inserted_count}")
        if backup_path:
            print(f"Backup: {backup_path}")
        else:
            print("Backup: no existing runtime files to copy")
        print(f"Log: {run_log_path}")
        print("Outputs:")
        print(" - output/unified_transactions.xlsx")
        print(" - output/review.xlsx")
    except Exception:
        logger.exception("Run failed; see traceback below")
        print(f"Run failed. Log: {run_log_path}")
        raise


if __name__ == "__main__":
    main()
