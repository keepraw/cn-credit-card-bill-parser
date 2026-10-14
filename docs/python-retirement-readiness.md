# Python retirement readiness (PR A)

For the subsequently verified browser-only XLSX → IndexedDB → JSON backup →
fresh-profile restore workflow across all six banks and three named schemas,
see [TypeScript historical migration](typescript-historical-migration.md).
The audit below is retained as the original PR A record; SQLite-only history and
other retirement boundaries still require separate verification.

Python is retained in this PR. The tested TypeScript production contract is ready
for review; **complete Python deletion is NO-GO now**. PR A must first be reviewed
and made available on the latest main, and the owner must explicitly authorize
PR B. The historical capability boundaries below must also be accepted. This is
not authorization to merge, deploy, delete data, or rewrite stored identities.

## Audited baseline and scope

- Repository: `keepraw/keepraw-ledger`.
- Main independently fetched at `8b1928754a1994a9c8c4fa62b760eeb5970ebf68`.
- PRs #12, #13, #14, #15 and #16 independently verified merged.
- Feature branch: `test/typescript-retirement-readiness-20261013`.
- Unmodified baseline Vitest: 271 passed, 6 optional private-statement tests skipped.
- All work and testing use an isolated worktree and synthetic inputs. Ignored user
  databases, statements, Excel files, logs and backups were not opened or changed.
- No new dependency, database version, backup version, ID algorithm or fingerprint
  algorithm. Python sources, tests, configuration and CI remain intact.

## Remaining Python responsibilities

The classifications describe a future reviewed retirement, not deletions made here.

| Python paths / responsibility | Classification | TypeScript evidence or retirement boundary |
| --- | --- | --- |
| `parsers/abc.py`, `boc.py`, `bocom.py`, `ccb.py`, `citic.py`, `icbc.py` | Required TypeScript validation first; validated for the supported layouts | Six registered TS parsers, synthetic parser/extraction/pipeline tests, immutable Golden comparisons. This does not prove every layout or original private source. |
| `parsers/legacy_xlsx.py`: named `统一账单` with nine full Chinese columns | Historical compatibility must remain supported | New strictly detected `legacy-unified-bill-v1`, preview, anomaly report, occurrence preservation and persistence tests. |
| `exporters.py`: `标准字段` and friendly `交易明细` historical data | Historical compatibility must remain supported | Existing `legacy-python-export-v1` and `legacy-keepraw-export-v1` retained and validated. CSV/XLSX export and formula-text safeguards remain in TS. |
| `legacy_xlsx.py`: repeated future-year rollback | Obsolete behavior explicitly suitable for retirement | Current date was an import-time heuristic, not statement evidence. Python can subtract multiple years and change leap day. TS preserves future dates, displays row-specific warnings and requests review. |
| `legacy_xlsx.py`: arbitrary first-sheet fallback / column aliases | Obsolete guessing explicitly proposed for retirement | The existing Python test demonstrates the named full-column format; no committed reference establishes another fixed schema. TS accepts three named complete schemas, rejects aliases/unknown sheets, and never guesses. This is a compatibility boundary, not proof that nobody ever used the fallback. |
| `normalizers.py`, `dedupe.py`, `hash_utils.py`, `models.py` | Safe to retire within the tested production contract | TS integer minor units, dates, identity, classification and occurrence-aware deduplication. Python native IDs are incompatible by design and are not migrated. Existing records keep IDs and edits. |
| `db.py`, `config.py`, `pipeline.py`: SQLite, folder batches, disk backups, file moves and export rollback | Obsolete standalone application responsibilities proposed for retirement | Dexie persistence, evidence retention/lifecycle and atomic JSON/ZIP restoration are independent production equivalents. No direct SQLite reader or automatic disk-folder migration is claimed. Keep all old databases and exports; a history existing only in SQLite still needs a verified export before its Python access path is retired. This audit does not verify private databases or their exports. |
| `extractors.py`: EML/HTML/text/PDF extraction | Safe to retire for supported text-based formats | Postal MIME, sanitized HTML and pdf.js coordinate extraction. Synthetic bank tests and browser imports validate the TS path. |
| `extractors.py`: optional OCR (`pytesseract`, `pdf2image`) | Obsolete optional capability proposed for retirement; not replaced | Optional dependency group, external OCR programs and no OCR acceptance test. README already excludes scanned PDFs from the Web contract. Do not claim scanned statements retain support. |
| `parsers/generic.py`, `parsers/registry.py`: generic fallback / unknown-bank and CSV guessing | Obsolete functionality proposed for retirement | Explicit TS registry intentionally refuses unknown formats. Python fallback and CSV ingestion have no equivalent generic TS parser; do not broaden import merely to preserve guesses. Supported historical XLSX is handled separately. |
| `cli.py`, `profiler.py`, `logging_utils.py`, `run_parser.ps1` | Obsolete standalone operations proposed for retirement | Import status, provenance, retained evidence and review UI replace operational visibility. Exact profiler Markdown output, debug-log format and automatic file renaming are not compatibility promises. |
| `clean_data.ps1` | Obsolete destructive Python runtime maintenance | Not executed. Browser clearing has separate real/demo/evidence/note lifecycle and rollback tests. Removing the entry point later must not delete its target directories' actual contents. |
| `golden.py`, `scripts/generate_golden.py`, `tests/test_golden.py` | Required TS validation first; transferred | TS independently validates and recomputes every committed reference. The existing TS generator now has a working `npm run golden:generate` launcher, tested with synthetic HTML. Python snapshot generation becomes historical; immutable `python.json` remains. |
| `migration_bridge.py`, `scripts/migration_audit.py` | Required TS auditing first; transferred with explicit retirements | TS read-only business-field audit and CLI operate on known XLSX plus a validated version-1 JSON backup. Occurrences consume exact evidence one-to-one; ambiguous candidates only request review. |
| Python audit's re-derived SHA-256 IDs, private `processed/` re-parses and hypothetical mapping simulation | Obsolete diagnostics explicitly suitable for retirement | Re-deriving incompatible IDs is unnecessary for observation. Desensitized Golden descriptions cannot prove raw history identity. The old simulation is not persistence evidence and can reuse occurrence evidence; no automatic mapping is ported. Actual import and IndexedDB tests now establish behavior. |
| All 16 Python pytest files | Safe to retire only in PR B after accepted equivalents and validation | Parser, normalization, dedupe, generic safety, logging, exporter/database rollback, historical XLSX, Golden and migration tests were inventoried. Their 73 tests still pass in PR A. CLI/logging/disk-export specifics become obsolete, not silently represented as browser tests. |
| `__init__.py`, `parsers/__init__.py`, `pyproject.toml`, `requirements.txt`, Python CI and runtime `.gitkeep` files | Safe to retire only with their consumers in PR B | Package plumbing and dependencies currently remain. Preserve ignored files and Golden references. The unified CI's deployment dependency must be updated only when the Python job is actually removed. |

## Historical XLSX corrections

All adapters still use existing date, currency, classification, money, identity
and persistence utilities. The new adapter requires the exact `统一账单` sheet
and all nine headers: `银行名称`, `卡号`, `交易日期`, `入账日期`, `交易详情`,
`交易币种`, `交易金额`, `入账币种`, `入账金额`. Duplicate headers are refused;
extra unrelated columns are ignored. It never imports the first sheet by guess.

Valid repeated rows retain independent occurrence IDs. Both original and
settlement monetary legs, signed integer minor amounts, currencies, transaction
and posting dates, source row and workbook provenance survive persistence. A
blank posting date uses the transaction date with `date_missing`; an invalid
nonblank date is excluded with its row number and reason. Future dates remain
unchanged, including leap days, and enter review using an existing flag.

The audit found additional financial defects and closes them without rewriting
stored records:

- Invalid original amounts previously fell back to settlement minor units,
  potentially manufacturing foreign-currency values. Both existing adapters now
  report and exclude those rows. They no longer strip arbitrary text into money
  or ignore an embedded currency that conflicts with its column.
- String fractional amounts for zero-decimal currencies could be magnified
  (`1.5` JPY becoming 15 minor units). They are refused, matching numeric handling.
- Five bank parsers read original currency codes but converted stripped amount
  strings using the default CNY exponent. Their existing money calls now pass the
  recognized currency, preserving zero-decimal original amounts. Currency-prefixed
  minus/parenthesis signs and numeric zero-decimal values are also preserved.
  Bank formatting such as `100.00` JPY is accepted only when all fractional digits
  are zero; `100.50` JPY is refused. An unsupported native currency fails parsing
  before any transactions can be imported, instead of guessing its exponent.
- Excel serial fractions represent time of day. Rounding previously moved an
  afternoon transaction into the following day; date conversion now truncates
  the time fraction.
- A 1904-date-system workbook is refused explicitly before serials are interpreted
  with the 1900 epoch. Supporting it later requires an explicit tested conversion.
- Unknown currency exponents are not guessed in historical adapters. Supported
  exponents are the existing money table (CNY/RMB, USD, HKD, EUR, GBP, SGD, AUD,
  CAD, CHF at two decimals; JPY, KRW, VND at zero). Other codes need a reviewed
  money-model extension. Unparseable rows remain visible in the exclusion report.
- Long numeric full-card values in the new adapter are refused because Excel may
  already have rounded them. Text card values and exact suffixes remain supported.

The two older format names, database schema and version-1 backup names remain
unchanged. Previously accepted malformed rows are now rejected rather than
silently repaired; successful old imports are not rewritten or retried.

## Cross-source identity and audit

PR #12's exact business-field matching, occurrence counts, collision-safe ID
allocation, completed-file hash idempotency and add-only persistence remain.
No lookup equates Python native IDs with TS fingerprints.

Previously, the suspect bucket included classification and only examined
contrasting descriptions. Thus historical purchase/native installment and
historical payment/native cashback disagreements could insert without a
candidate warning. Posting-date and original-money differences with the same
text could also remain invisible. A new read-only scope index observes these
cases without weakening exact deduplication. Bank, card, transaction date,
settlement currency and signed settlement amount locate candidates; description,
posting date, type, direction and both original-money fields distinguish them.
Unknown identity scope is not treated as migration evidence.

Only newly inserted candidates receive `suspected_duplicate` and `pending`.
Existing transactions, user categories, flags, decisions, provenance and separate
review notes are never written back. Candidate IDs are bounded examples and
counts report the whole scope; they are not merge instructions. The audit consumes
exact business occurrences once, independently of native ID labels.

Tests use actual XLSX preview/confirmation, ingestion and IndexedDB persistence
in both import orders. They cover classification, dates, normalized-description
collisions, original currency/amount disagreements, repeated exact purchases,
ambiguous repeated installments, file re-imports, edits and separate notes.
Fourteen selected regressions fail when the original money/adapters/dedupe/ingest
implementations are substituted, and pass with this correction. Seven additional currency/parser regressions fail
with the original implementations and pass after the minimal currency corrections.

Run a local read-only audit from `web/`:

```bash
npm run migration:audit -- --legacy /path/to/history.xlsx --backup /path/to/credit-card-data.json
```

The CLI validates the backup, uses the production historical adapters and reports
counts, row positions, candidate IDs and differing field names. It does not log
raw descriptions, dates, amounts or filenames, or write either input/database.
It does not compare raw descriptions against desensitized Golden text. A synthetic
integration test executes the CLI and verifies both inputs remain unchanged.

Ambiguous rows are retained on both sides. Inclusive reports may double-count
until review resolves them; a warning is not an automatic accounting correction.
Exact fully equal overlapping rows retain the existing maximum-occurrence rule.
If separate sources carry no evidence distinguishing a new equal business event
from overlap, import-order independence cannot establish real-world identity.
Already lost transactions, mis-scaled original currency values and incorrect
imported dates/signs cannot be reconstructed by this change. No automatic recovery or stored-record repair occurs.

## Independent Golden replacement and privacy

TypeScript tests read the four committed JSON files for each of the six banks,
validate required schema/metadata, calendar dates, safe integer money, currency,
direction, native identities and source positions, compare P0 multisets with
multiplicity, and recompute the entire stored diff and identity pairing.
Audited reference digests prevent silent edits to the existing approved warnings.
Severity rules remain unchanged, with synthetic blocking-mutation tests separate
from reference-file validation. No expected file was regenerated or changed.

The committed-reference gate compares frozen JSON outputs; it does not execute
the current parsers against the six private originals. Financial hardening adds
`currentParserGolden.test.ts`, which invokes all six current TypeScript parsers on
invented templates and checks independently specified counts and financial
multisets through ingestion and persistence. It covers both monetary legs,
currencies, direction and classification without changing approved references.
Neither gate by itself establishes that all private historical layouts still parse.

The financial hardening also rejects malformed separators and conflicting currency
tokens, refuses unsafe monetary legs in recognized transaction rows instead of
silently omitting or substituting them, and preserves parsed negative signs or
rejects contradictory directions. Dashboard amounts and charts explicitly exclude
non-CNY settlement rows without conversion. Suspected duplicates remain separate
and included, with a statistics warning and bounded, read-only source comparisons
rebuilt from the ledger. No database schema, identity algorithm or stored history
is rewritten; existing recovery and Python retirement prerequisites still apply.

| Bank | Transactions | Recomputed result |
| --- | ---: | --- |
| BOC | 4 | 1 description WARNING |
| ICBC | 7 | 7 description WARNINGs |
| ABC | 15 | PASS |
| CCB | 5 | PASS |
| BOCOM | 23 | PASS |
| CITIC | 12 | PASS |
| Total | 66 | 0 BLOCKING, 8 existing description WARNINGs |

These references observe six historical cycles, not all possible statements.
Golden v1 records the settlement leg, not original-currency amounts, native
classification or reconciliation summaries; separate synthetic tests cover those.
Real source documents are unavailable to this isolated synthetic validation;
optional private acceptance tests are skipped, not passed. Synthetic parser
fixtures continue to exercise actual TS parsing independently.

Privacy findings: approved fixtures retain bank/card/month directory names,
original bank/card/month filenames, four-digit suffixes, sizes and full source
SHA-256 hashes, native transaction IDs, exact cycles/dates, signed amounts and
structural description prefixes. Merchant labels use deterministic short hashes,
which can permit correlation or dictionary guesses; raw-text masking is partial
by design. A `desensitized` flag is not proof of anonymity. No unredacted statement
was added. These linkable financial references are retained byte-for-byte per the
owner's instruction. Further redaction requires separate explicit authorization
and a reviewed baseline/privacy plan; it must not be presented as a regression fix.

The fetched main workflow [38417662756](https://github.com/keepraw/keepraw-ledger/actions/runs/38417662756)
completed successfully with Web, Python and Deploy jobs. This was read-only
verification of the existing main run, not a deployment triggered by this work.

## Validation executed

Environment: Node 24.19.0, Python 3.12. Browser tests run in an isolated Chromium
context with synthetic data. An initial browser run lacked the Chromium binary;
after installing the matching Playwright browser the complete suite passed.
The audit CLI integration initially required child-process sandbox access, and
its JSON logging was corrected before the final successful suite.

| Command / check | Actual result |
| --- | --- |
| `npm ci` | Passed with the committed lockfile and maintainer XLSX distribution |
| `npm run typecheck` | Passed |
| `npm run lint` | Passed; two existing console warnings in the Golden generator |
| `npm test` | 324 passed, 6 optional private-statement tests skipped |
| `npm run build` | Passed |
| `npm run test:e2e` | 12 passed, 2 optional private-statement tests skipped |
| `npm audit --json` | Zero vulnerabilities; no suppressions |
| `python -m pytest -q` (isolated existing dependencies) | 73 passed |
| Official actionlint 1.7.12, release checksum verified | Passed |
| CI YAML/permissions/artifact checks and 10 event/job-result cases | Passed |
| Executed unchanged revision guard: current SHA, stale SHA, API error | Passed; stale skipped, lookup failure failed closed |
| Git scope / whitespace checks | Passed; Python and approved Golden JSON unchanged |

The 53 new Vitest cases include the immutable reference gate, historical format
and financial validation, import/persistence behavior, v1-to-v2 database opening,
JSON round trip, audit CLI and synthetic Golden generator. Existing six-parser,
ZIP/JSON backup rejection/atomicity, evidence rollback/lifecycle, demo isolation,
review and export tests also pass. Version-1 backups do **not** include separately
stored free-text review notes; the new round-trip test demonstrates that limitation.
Locally retained notes survive imports and compatible database opening.

The new Chromium benchmark creates 100,000 synthetic transactions, plans ingestion,
writes real IndexedDB, reads a snapshot, imports an overlapping 100,001-row source,
checks 100,001 distinct IDs and exact integer total, and verifies count after reload.
One measured run: plan 475 ms; first write 7,425 ms; snapshot read 3,284 ms; overlap
plan 637 ms; total 15,140 ms. Only one occurrence is added. There is no wall-clock
pass/fail threshold; the test has a normal execution timeout. This measures the
browser/persistence path, not statement parsing speed or every device. Vitest's
100,000-row dedupe and 18,500-row XLSX tests run in memory/fake IndexedDB and are
not represented as real-browser database measurements.

## PR B gate and remaining limitations

No newly discovered critical defect remains in the validated supported contract.
**Deletion remains NO-GO** until PR A is accepted on the latest main, the owner
explicitly authorizes PR B and accepts the proposed obsolete-capability boundaries.
Do not claim all private historical data has a verified XLSX export; histories
existing only in SQLite remain a migration precondition, not disposable files.

PR B must remove Python consumers together, preserve the three TS adapters and
all approved references, and rerun the mandatory suite. Keep one CI workflow:
PR validation stays read-only; Web checks, security audit and Chromium tests must
finish before uploading the same-run Pages artifact. Removing the Python job
requires removing only that obsolete `deploy.needs` member. Main/event restrictions,
current-main lookup, normal success gating, deployment-only write permissions,
serialized deployment and concurrency protections remain mandatory. Current CI
is unchanged and no deployment was triggered during this audit.

This PR does not merge or enable auto-merge. It does not delete Python, ignored
financial files or existing data; change database/fingerprint/transaction IDs;
include separate notes in v1 backups; provide OCR, generic CSV parsing or direct
SQLite migration; or guarantee universal bank-layout compatibility.
