# TypeScript historical migration

The browser can migrate the three supported historical XLSX schemas without
running Python, generating SQLite, or calling a parsing service. Python remains
an independent application and is not deleted by this change.

The audited production path is `AppStore.previewLegacyImport` →
`previewLegacyWorkbook` → `readSheetData` / SheetJS, followed by
`planLegacyImport` → `persistLegacyImport` / Dexie. JSON uses
`exportDataBackup` and `importBackup`; spreadsheet export uses `downloadXlsx`.
None of these paths launches Python or reads SQLite. The optional
`migration:audit` developer command also runs Node and loads the TypeScript
adapters directly. Frozen Golden files named `python.json` are test references,
not processes or migration prerequisites.

## User workflow

1. Open the web app, then disable Demo Mode in Settings.
2. In Import, choose **历史 Excel 导入** and select an existing supported workbook.
3. Check the preview's source-row count, importable count, date range and banks.
   Inspect every excluded row and date warning before confirming.
4. Confirm the import. TypeScript writes valid rows atomically to IndexedDB.
5. Review transactions, currencies and suspected duplicates. Historical XLSX
   has no balance summary, so an imported history is not presented as reconciled.
6. In Transactions, clear filters to include the whole ledger and export Excel
   for an ordinary spreadsheet archive. The export includes both monetary legs,
   bank, card suffix, dates, description, type, direction, transaction ID,
   fingerprint and occurrence number. Amounts and card suffixes are text cells
   so spreadsheet formatting cannot discard precision or leading zeros.
7. In Settings, export `credit-card-data-YYYY-MM-DD.json`. Save it outside browser storage.
8. In a fresh browser profile or installation, open Settings and restore that
   JSON file. No original XLSX, Python installation or SQLite database is needed.
9. Recheck counts and transactions. Repeating restore or importing the original
   workbook again does not create additional copies of existing occurrences.

The JSON backup remains version 1 and retains statements, transactions, import
records and settings. Separately stored review notes and original documents are
not part of JSON. Keep the original statements separately, or use the existing
ZIP archive for original files that are actually stored. XLSX is a readable
archive, not an application backup; it is not a fourth historical import schema.
No exchange-rate conversion is performed. Foreign settlement records remain
available in the ledger and exports, with existing CNY dashboard rules unchanged.

## Supported inputs and banks

| Sheet | Adapter | Banks verified in the full migration/recovery workflow |
| --- | --- | --- |
| `标准字段`, complete 15 snake_case columns | `legacy-python-export-v1` | BOC, ICBC, ABC, CCB, BOCOM, CITIC |
| `交易明细`, nine fixed Chinese columns | `legacy-keepraw-export-v1` | BOC, ICBC, ABC, CCB, BOCOM, CITIC |
| `统一账单`, nine full historical Chinese headers | `legacy-unified-bill-v1` | BOC, ICBC, ABC, CCB, BOCOM, CITIC |

These schemas can contain multiple banks in one workbook. The PDF/EML bank
parsers remain responsible for their registered statement formats; historical
structured XLSX uses the explicit TypeScript adapters. An arbitrary bank's XLSX
layout, renamed columns, unknown sheet or incomplete schema is not guessed.
An existing `标准字段` export may have been produced by an old tool, but importing
an already available file never requires that tool to run again. A history that
exists only in a SQLite database is outside this XLSX workflow; do not delete its
only access path or claim those native IDs were migrated.

## Data and identity guarantees

- Both original and settlement currencies and amounts are parsed independently
  as integer minor units. Invalid money, unsupported currency precision and
  currency conflicts remain explicit source-row anomalies. Original money is
  never borrowed from settlement money.
- Bank, card suffix, dates and descriptions are retained under the existing
  documented normalization rules. Types use the existing classification rules;
  direction comes from the signed settlement amount. These historical schemas
  do not contain separate native type, direction or transaction-ID columns.
  Metadata absent from the input cannot be recovered by guessing.
- The existing TypeScript fingerprint/occurrence algorithm assigns IDs once.
  Identical repeated transactions retain separate occurrence IDs. Exact matches
  reuse existing ledger IDs, including after JSON recovery. No Python-native ID
  is substituted for a TypeScript ID, and the identity algorithm is unchanged.
- JSON recovery preserves every transaction field, including ID, fingerprint,
  occurrence, type, direction, provenance and review flags. Import-record
  `duplicateOf` references and reconstructed suspected-duplicate candidates
  survive recovery. Suspected duplicates remain separate transactions.
- Excel serial date handling, future-date review and rejection of the 1904 date
  system retain their existing safeguards. Backup validation and conflict checks
  remain active; database schema and backup format are unchanged.

## Executed validation

`web/tests/fixtures/historicalMigration.ts` creates independent invented XLSX
data in JavaScript. Each schema contains all six banks, all ten transaction
types, exact repeated purchases, a suspected duplicate, signed original and
settlement money, two-decimal and zero-decimal currencies, and text/numeric cells.
Expected amounts and classifications are literal references, not Python output.

`web/tests/historicalMigration.test.ts` exercises XLSX preview, atomic IndexedDB
persistence, duplicate import, serialized JSON export, empty-database restore,
repeat restore and an overlapping file import. It compares every financial field,
ID, occurrence and duplicate candidate relationship.

`web/e2e/historicalMigration.spec.ts` performs the actual UI flow in Chromium for
each schema. It downloads and reads the XLSX independently, downloads the JSON,
restores it into a separate empty browser profile, reloads, and checks all
transaction fields and duplicate relationships. Only static same-origin GETs
and the local development socket are allowed; backend requests, external traffic
and database/preprocessing downloads fail the test. No Python process or SQLite
input participates in this workflow.

Run from `web/`:

```bash
npx playwright install chromium   # once, for the browser check
npm run test:migration
```

This verification command runs only Node/TypeScript and Chromium. The existing
CI Web job also discovers both suites through its normal unit and browser runs;
the separate Python job remains unchanged until Python retirement is authorized.

Real statements and their backups remain private local validation inputs. They
must not be committed, uploaded to CI or used as public test fixtures. This
evidence covers the named schemas and tested layouts, not universal compatibility
with every bank statement or a blanket authorization to retire Python.
