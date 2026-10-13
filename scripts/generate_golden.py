"""Golden fixture generator (Python side).

Usage:
    python scripts/generate_golden.py gen --input processed/xxx.eml --out golden/<bank>/<stmt>
    python scripts/generate_golden.py diff --dir golden/<bank>/<stmt>

Only uses existing parser entry points (extract_source, parse_statement,
assign_ids). Never modifies parser behavior.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "src"))

from ccparser.dedupe import assign_ids  # noqa: E402
from ccparser.extractors import extract_source  # noqa: E402
from ccparser.golden import (  # noqa: E402
    build_input_meta,
    diff_normalized,
    normalize_python_statement,
)
from ccparser.parsers.registry import parse_statement  # noqa: E402


def cmd_gen(args: argparse.Namespace) -> int:
    input_path = Path(args.input)
    out_dir = Path(args.out)
    if not input_path.is_file():
        print(f"input not found: {input_path}", file=sys.stderr)
        return 2

    source = extract_source(input_path)
    statement = parse_statement(source)
    assign_ids(statement)

    out_dir.mkdir(parents=True, exist_ok=True)
    meta = build_input_meta(
        input_path,
        file_hash=source.file_hash,
        source_type=source.source_type,
        statement=statement,
        desensitized=not args.no_desensitize,
    )
    python_doc = normalize_python_statement(statement, desensitize=not args.no_desensitize)

    (out_dir / "input.meta.json").write_text(json.dumps(meta, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    (out_dir / "python.json").write_text(json.dumps(python_doc, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"bank={statement.bank} card={statement.card_last4} "
          f"cycle={statement.statement_start}/{statement.statement_end} "
          f"txs={len(statement.transactions)} parser={statement.parser_name}")
    print(f"wrote {out_dir / 'input.meta.json'} and {out_dir / 'python.json'}")
    print("Next: run web/scripts/generate-golden.ts on the same input file to produce web.json, then `gen diff`.")
    return 0


def cmd_diff(args: argparse.Namespace) -> int:
    golden_dir = Path(args.dir)
    python_path = golden_dir / "python.json"
    web_path = golden_dir / "web.json"
    if not python_path.is_file() or not web_path.is_file():
        print(f"need both python.json and web.json in {golden_dir}", file=sys.stderr)
        return 2
    python_doc = json.loads(python_path.read_text(encoding="utf-8"))
    web_doc = json.loads(web_path.read_text(encoding="utf-8"))
    report = diff_normalized(python_doc, web_doc)
    (golden_dir / "diff.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    counts = report["severityCounts"]
    print(f"verdict={report['verdict']} paired={report['pairedRows']} "
          f"BLOCKING={counts['BLOCKING']} WARNING={counts['WARNING']}")
    for finding in report["findings"][:20]:
        print(f"  [{finding['severity']}] {finding['rule']} {finding}")
    return 0 if report["verdict"] != "BLOCKING" else 1


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Golden fixture generator (read-only wrt parsers).")
    sub = parser.add_subparsers(dest="command", required=True)

    gen = sub.add_parser("gen", help="Parse a real bill file into input.meta.json + python.json.")
    gen.add_argument("--input", required=True, help="Real bill file (never copied into golden/).")
    gen.add_argument("--out", required=True, help="golden/<bank>/<statement> directory.")
    gen.add_argument("--no-desensitize", action="store_true",
                     help="Keep raw descriptions (local debugging only; never commit).")
    gen.set_defaults(func=cmd_gen)

    diff = sub.add_parser("diff", help="Compare python.json and web.json into diff.json.")
    diff.add_argument("--dir", required=True, help="golden/<bank>/<statement> directory.")
    diff.set_defaults(func=cmd_diff)

    args = parser.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
