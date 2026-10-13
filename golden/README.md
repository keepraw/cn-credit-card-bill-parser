# Golden Fixtures (Task A-3.4)

Cross-pipeline regression baseline. Compares **normalized** outputs, never the
native `Transaction` models directly (see A-3.2/A-3.3 audits).

## Layout

```text
golden/
  <bank>/                  # boc | icbc | abc | ccb | bocom | citic (Web BankId)
    <card>_<yyyymm>/       # e.g. 3443_202607 (statement identity, no PII)
      input.meta.json     # traceable input reference (hash, no content)
      python.json         # golden/v1 normalized Python output (desensitized)
      web.json            # golden/v1 normalized Web output (desensitized)
      diff.json           # diff report (BLOCKING / WARNING / INFO + identity table)
```

## Rules

1. **Raw bills are never committed.** `processed/`, `inbox/` and `*.eml/*.pdf`
   are git-ignored. Only `input.meta.json` (file name, size, SHA-256, cycle,
   counts) is stored, so a run is reproducible without leaking content.
2. **Committed outputs are desensitized** (`"desensitized": true`). Merchant and
   personal names become `商户_<fnv1a32>` placeholders (order-independent, so
   both pipelines map the same merchant to the same placeholder); dates,
   amounts, currencies, directions, row counts and structural prefixes
   (`消费`, `还款`, `(存入)` …) are preserved byte-for-byte.
3. **The golden layer never merges.** `diff.json → identity` only observes which
   business keys pair (`full` / `partial` / `unpaired`, always `merged: false`).
4. **P2 fields are never compared** (`merchant`, `category`, `flags`, `summary`).

## Regenerate (needs the original file with matching SHA-256)

```bash
# Python side
.venv/Scripts/python scripts/generate_golden.py gen --input processed/<file> --out golden/<bank>/<stmt>

# Web side (from web/)
node_modules/.bin/vite-node scripts/generate-golden.ts --input ../processed/<file> --out ../golden/<bank>/<stmt>

# Diff
.venv/Scripts/python scripts/generate_golden.py diff --dir golden/<bank>/<stmt>
```

## Batches

- Batch 1: `icbc/3443_202607`, `abc/3982_202607`, `ccb/5574_202607` — real EML.
- Batch 2: `boc/6505_202607` (real PDF via pdfplumber / pdf.js geometry),
  `bocom/5155_202607` (real EML), `citic/7650_202607` (real EML, Web side uses
  the experimental parser, see below).

## CITIC note

CITIC (`citic_eml`) is a registered production parser (`web/src/parsers/citic.ts`,
in `PARSERS`). The golden generator resolves it through the normal registry
path (`detectParser`), so `golden/citic/*/web.json` is reproducible with no
special cases. History: on the old `main` the parser was reverted (`f1c81b6`)
and the baseline temporarily used an unregistered copy; after the
experimental → main migration the production parser is authoritative and no
duplicate exists in the tree.
