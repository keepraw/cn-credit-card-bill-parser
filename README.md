# Keepraw-Ledger

**A privacy-first, local-first credit card statement parser, ledger, and reconciliation tool for Chinese bank statements.**

Keepraw-Ledger converts supported credit card statements into structured transactions for review, reporting, and archival. The repository contains two independent applications:

- **Web app (primary interface):** A browser-based React and TypeScript application with IndexedDB storage, statement import, transaction review, reconciliation, and backup tools.
- **Python CLI:** A standalone batch-processing pipeline that reads files from local folders, stores results in SQLite, and exports Excel workbooks.

**Live project homepage:** [ledger.keepraw.com](https://ledger.keepraw.com/) (as listed in the GitHub repository settings).

The web app and Python CLI are **separate data-processing implementations**. They do not share a database or automatically synchronize their results. This project is under active development and is not a replacement for your bank's official records.

## Features

The web application currently includes:

- **Statement import:** Bank-specific PDF and EML parsers, with explicit format detection instead of an unrestricted generic fallback.
- **Transaction ledger:** Search, filtering, categorization, manual editing, and CSV/XLSX export.
- **Reconciliation:** Compare parsed transactions with available bank statement summaries; flag missing or mismatched data for review.
- **Data quality and review:** Surface low-confidence rows, possible duplicates, and incomplete information.
- **Dashboard:** Spending summaries and trends. Unreconciled statements are excluded from the dashboard by default.
- **Local-first storage:** IndexedDB through Dexie, with original statement attachments stored when the browser permits.
- **Demo mode:** In-memory fictional sample data, isolated from the real ledger and blocked from real-statement imports.
- **Backup and restore:** Lightweight JSON data backups and ZIP archives containing available original documents.
- **Legacy import:** Explicit adapters for recognized historical XLSX export formats, with a preview before import.

Amounts are represented internally as integer minor currency units (for example, cents or fen) rather than accumulated as floating-point currency values. This does **not** eliminate the need to validate parsing, transaction direction, and reconciliation results.

## Supported statement formats

These are the formats registered by the **web** parsing pipeline.

| Bank | Input format | Parser |
| --- | --- | --- |
| Bank of China (BOC) | Text-based PDF statement | `boc_pdf` |
| Industrial and Commercial Bank of China (ICBC) | HTML email statement (`.eml`) | `icbc_eml` |
| Agricultural Bank of China (ABC) | HTML email statement (`.eml`) | `abc_eml` |
| China Construction Bank (CCB) | HTML email statement (`.eml`) | `ccb_eml` |
| Bank of Communications (BOCOM) | HTML email statement (`.eml`) | `bocom_eml` |
| China CITIC Bank | HTML email statement (`.eml`) | `citic_eml` |

**Scope:** These parsers support the bank statement layouts they have been developed and tested against, **not every historical or regional variation** of each bank's statement. The web app does not currently provide OCR for scanned, image-only PDFs. Unrecognized files should be treated as unsupported and checked manually.

Historical XLSX import is a **separate migration workflow**, not a general-purpose Excel statement parser. See `web/src/importers/` for the supported legacy adapters.

## Getting started with the web app

### Use the hosted app

1. Open the [project website](https://ledger.keepraw.com/).
2. Explore **Demo Mode** on first use. The example transactions are fictional and remain separate from the real database.
3. Open **Settings**, disable Demo Mode, then open **Import**.
4. Choose or drag in supported PDF/EML statements. Multiple files can be selected together.
5. Examine the **Reconciliation**, **Data Quality**, and **Review** views before relying on the dashboard totals.
6. Export a backup from **Settings**, and store the file somewhere outside your browser.

The site is a static frontend: it does not require a project account or an application server to store financial records. Opening the hosted site still involves downloading its HTML, JavaScript, and other assets.

### Run locally

**Requirements:** Node.js 22 and npm are recommended for consistency with the repository's GitHub Actions workflow.

```bash
git clone https://github.com/keepraw/keepraw-ledger.git
cd keepraw-ledger/web
npm ci
npm run dev
```

Vite prints the local URL, generally `http://localhost:5173/`. No API key, cloud database, or external parsing service is needed.

### Web development commands

Run these commands from the `web/` directory:

```bash
npm run typecheck            # TypeScript
npm run lint                 # ESLint
npm test                     # Vitest unit and integration tests
npm run build                # Production build
npm run verify               # Typecheck + lint + tests + build
npx playwright install chromium
npm run test:e2e             # Playwright browser tests
```

The single Validation workflow (`.github/workflows/ci.yml`) runs Web checks (TypeScript, ESLint, Vitest including goldens, build, npm audit, and Chromium Playwright) and Python pytest including goldens in parallel. Deployment requires both jobs to succeed and a push or explicit dispatch on `main`. It reuses that run's validated `web/dist` artifact; PRs neither upload Pages artifacts nor deploy. Deployments are serialized, and superseded main revisions are skipped. For a GitHub Pages project subpath instead of the configured custom-domain root, set `VITE_BASE_PATH` for the build.

## Storage, privacy, and backup

### What stays local

The web application parses statements in the browser and stores ledger data under the current site's origin in **IndexedDB**. It does not have a dedicated backend that receives your statements.

This is a **local-processing model**, not a promise that the device never connects to the internet. The hosted website must load static assets, and other software on your device (including browser extensions) is outside the application's control.

IndexedDB data is isolated by browser profile and site origin:

- Different devices and browser profiles do not automatically share data.
- The hosted domain and `localhost` do not automatically share data.
- Clearing site data, using private browsing, or browser storage eviction can remove your local ledger.

### Backup formats

| Backup type | Includes | Excludes / caveats |
| --- | --- | --- |
| **JSON data backup** | Statements, transactions, import records, application settings | Original PDF/EML files and separately stored review notes |
| **Full ZIP archive** | JSON database, manifest, and original files still available in IndexedDB | Original files already missing from browser storage; separately stored review notes |

A full archive reports missing original documents in its manifest rather than inventing them. Both formats contain sensitive financial data and are **not encrypted by the application**. Protect downloaded backups accordingly.

Backup restoration merges records by primary key; importing the same backup again does not create a new copy of the same primary-key records. **Existing records with matching IDs may be replaced.** Keep a separate backup before any restoration or migration.

### Data deletion limitation

**Known issue:** The current **Clear Real Data** operation clears real statement, transaction, and import rows, but does **not** also remove all stored original-file attachments or review notes. Therefore, it must **not** be treated as secure erasure of private information.

For local cleanup, back up anything you need first, then use **Clear All Data** to remove ledger rows and attachments, or clear the site's browser storage. Application settings may remain after the in-app operation; clearing site storage is the more complete browser-side cleanup.

## Standalone Python CLI

The Python pipeline remains available for local folder-based processing and Excel exports. It is **independent** of the web application, and its supported source formats and parsing behavior may differ.

**Requirements:** Python 3.10 or newer (Python 3.12 recommended).

From the repository root:

```bash
python -m venv .venv
# Linux / macOS
source .venv/bin/activate
python -m pip install -r requirements.txt
```

On Windows PowerShell, activate the environment using:

```powershell
.\.venv\Scripts\Activate.ps1
python -m pip install -r requirements.txt
```

Put statement files in `inbox/`, then run:

```powershell
# Windows PowerShell
.\run_parser.ps1
```

```bash
# Linux / macOS
PYTHONPATH=src python -m ccparser.cli
```

The Python pipeline uses these directories:

| Path | Purpose |
| --- | --- |
| `inbox/` | Input statements awaiting processing |
| `processed/` | Original files processed successfully |
| `review_files/` | Original files needing manual attention |
| `data/` | Local SQLite data |
| `output/unified_transactions.xlsx` | Consolidated transaction export |
| `output/review.xlsx` | Items requiring review |
| `backups/` and `logs/` | Local runtime backups and diagnostic logs |

For profiling without importing transactions, debugging, or unit tests:

```bash
PYTHONPATH=src python -m ccparser.cli --profile
PYTHONPATH=src python -m ccparser.cli --debug
python -m pytest -q
```

The CLI also has historical spreadsheet import and optional OCR-related dependencies. Scanned PDFs may need additional local setup; do not assume OCR works out of the box. Review the older pipeline's documentation and test cases before processing important original statements.

## Repository layout

```text
web/
  src/app/               React application state
  src/core/              Amounts, identity, dedupe, analytics, reconciliation
  src/parsers/           Bank-specific browser parsers
  src/db/                Dexie and IndexedDB storage
  src/importers/         Historical XLSX import adapters
  src/backup/            Data and full-archive backup logic
  src/ui/                Views and components
  tests/                 Vitest unit and integration tests
  e2e/                   Playwright tests
src/ccparser/            Independent Python parser implementation
tests/                   Python pytest suite
scripts/                 Migration and golden-fixture tooling
golden/                  Desensitized cross-pipeline regression baselines
docs/                    Parser and format research
.github/workflows/       Unified Web/Python validation and GitHub Pages deployment
```

## Development and correctness guidelines

Changes to bank parsers, monetary amounts, deduplication, migration, or backup logic should be tested against **synthetic or desensitized fixtures**. Check transaction counts, duplicate occurrences, signed amounts, currencies, statement periods, reconciliation differences, and review flags.

The repository includes golden fixtures for the six registered banks (`golden/README.md`), plus focused Web and Python tests. These are regression aids, **not** proof that every statement template is supported or every financial edge case has been verified.

### Known limitations requiring follow-up

- **Cross-import duplicate occurrences:** Identical real transactions appearing more than once may be incorrectly collapsed when overlapping sources are imported. Review duplicates carefully until this logic is corrected and regression-tested.
- **Stored attachment lifecycle:** Clearing real data currently leaves some associated raw attachments and review notes behind.
- **Import error paths:** The association between import results and retained raw files needs stronger handling when a file cannot be read.
- **Backup integrity:** Restore validation should check individual records and cross-record consistency, not just top-level JSON structure.
- **Testing and dependencies:** Keep Python and browser checks mandatory, monitor dependency advisories, and extend large-dataset coverage as needed.

This is a personal finance data tool. **Always compare imported results with official bank statements** before using the output for financial decisions.

## Protecting real statements

Never commit original credit card statements, unredacted transaction records, log files, database files, or backup archives to the public repository. The `.gitignore` ignores typical sensitive file types and runtime folders, but it is not a substitute for checking staged files:

```bash
git status --short
git diff --cached --name-only
```

If a sensitive file was committed, deleting it in a later commit does not remove it from Git history. Treat exposed information accordingly and review the repository history.

## License

There is no `LICENSE` file in the repository at the time of writing. Public source visibility alone does not grant permission to redistribute or relicense this work. Add an explicit license if external usage or contributions are intended.
