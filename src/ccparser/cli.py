from __future__ import annotations

import argparse

from .pipeline import ensure_directories, run
from .profiler import profile_inbox


def main() -> None:
    parser = argparse.ArgumentParser(description="cn-credit-card-bill-parser: local Chinese credit card bill parser")
    parser.add_argument(
        "--profile",
        action="store_true",
        help="Only inspect inbox file formats and write a redacted report; do not import transactions.",
    )
    args = parser.parse_args()

    ensure_directories()
    if args.profile:
        report_path = profile_inbox()
        print(f"Format profile written to: {report_path}")
        return

    processed_count, inserted_count = run()
    print(f"Processed files: {processed_count}")
    print(f"Inserted transactions: {inserted_count}")
    print("Outputs:")
    print(" - output/unified_transactions.xlsx")
    print(" - output/review.xlsx")


if __name__ == "__main__":
    main()
