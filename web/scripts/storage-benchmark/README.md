# Synthetic Chromium storage benchmark

This is an independent benchmark, not application code. It reads no user ledger,
statement directory, or private workbook. It leaves all production schemas,
identities, importers, exports, and UI unchanged and adds no dependencies.

From `web/`, after installing the existing locked dependencies and Chromium:

```sh
CHROMIUM_PATH=/usr/bin/chromium node scripts/storage-benchmark/run.mjs
node scripts/storage-benchmark/maintenance.mjs
node scripts/storage-benchmark/summarize.mjs
node scripts/storage-benchmark/report.mjs
```

If using Playwright's bundled Chromium, set `CHROMIUM_PATH` to its executable.
`BENCH_SCRATCH` selects a writable directory for newly created isolated profiles
(default `/workspace/scratch`); `BENCH_OUTPUT` selects the aggregate JSON result.
The runner prints and retains its temporary directory for inspection. Only those
new synthetic artifacts are eligible for later cleanup. No existing profile is
opened. `BENCH_QUICK=1` is a development smoke run and omits the required large
scales; do not use it for the full report.

The runner builds the actual application and a separate AppStore probe with
Vite in production mode. Its temporary HTML input is removed afterward. A local
HTTP server serves only compiled assets and generated XLSX bytes. Playwright
blocks external page requests. Normal scenarios use real Chromium IndexedDB,
the existing TypeScript importer, AppStore preview/confirm, repository
persistence, and React refresh. Files are generated with SheetJS using seed
`0x4b524c31`; workbook timestamps are fixed and fixture SHA-256 is recorded.

The principal storage checkpoint is immediately after the normal import and
refresh, before auxiliary measurements. It samples `storage.estimate()` five
times, 100 ms apart. Each fresh profile has its own empty-schema/settings
baseline. Three fresh profiles are used for 18,000 and 100,000 rows. There is
one 36,000-row run and one run each for the other two historical adapters and
longer raw text. Browser reopen measurements are retained separately: LevelDB
compaction can change file usage without changing live records.

JSON is compact `JSON.stringify` encoded with `TextEncoder` (UTF-8), including
array delimiters. Transaction-object means omit array separators. Per-field
marginal JSON costs include keys, punctuation, and encoded values. Attachments
report binary `ArrayBuffer.byteLength` separately from their metadata JSON.
Serialization-only counterfactual copies never alter stored transactions.

The index controls use an additional **scratch** native IndexedDB database in
fresh profiles. The payload consists of full objects from the real importer.
Both controls have identical stores/primary keys; one copies all secondary
indexes and the other has none. Their empty scratch baselines are subtracted.
This estimates the aggregate effect of secondary indexes and their interaction
with LevelDB. It does not produce exact per-index disk sizes or propose a
production schema change.

Closed-profile file measurements sum `stat.size` and `stat.blocks * 512` under
that profile's `Default/IndexedDB`, including logs, SSTables, manifests, and
Chromium external-value files. Directory inode/metadata allocation, filesystem
compression, and physical-device write amplification are excluded. These are
container filesystem measurements, not a desktop SSD throughput benchmark.

Performance timings use browser `performance.now()`. Import totals exclude the
fixture HTTP fetch and synthetic file generation, include hashing, both
AppStore snapshot reads, preview, confirm, persistence, refresh, and two
animation frames. Component preview/planning tests start with an empty
snapshot. Persistence samples clear and reinsert only synthetic rows via
`persistLegacyImport` after the primary storage checkpoint. The timings are
kept separate and must not be added as if they were one execution trace.

Five reads/filter/sort/backup/refresh samples and five real UI interaction
samples are recorded. UI timings start at the captured DOM event and end after
two animation frames; Playwright dispatch latency is excluded. Refresh commit
uses a layout-effect probe, which includes read time and React scheduling and
rendering; it is not a pure React CPU measurement. Startup uses the real app
entry and records navigation-to-ready in three new tabs. The first empty
application visit displays in-memory demo rows, which are not persisted.
Assets are served locally with no network throttling; browser hardware and
real deployment latency can differ.

JSON backup timings include repository reads, the existing pretty-printed
serialization, and Blob construction. The round-trip calls the actual
AppStore restore method using its own exported synthetic JSON, so the existing
size guard is exercised. The lifecycle test repeats the identical XLSX five
times, imports an alternate container with identical financial rows but a new
hash, then performs ten edit/note/JSON-download cycles. The evidence test calls
`saveOriginalFile` five times with the same synthetic bytes/hash, separately
from historical imports (which do not retain XLSX attachments).

`maintenance.mjs` is a separate follow-up after the full runner exits. It serves
the retained build at the same origin and copies only profiles named in this
synthetic run. Three browser cycles issue native read-only `getAll` requests,
close the database/browser, and measure quota/file bytes and live counts again.
It neither forces compaction nor changes rows. This distinguishes LevelDB
layout/obsolete-file cleanup from application duplication. Index-control empty
baselines still come from the original run.

An additional fresh profile simulates one older persisted demo transaction,
its matching statement/import, one note, and one hash-valid synthetic text
attachment. IDs and fingerprint are preserved. Loading the actual application
exercises its existing startup purge; before/after counts reveal whether
evidence or notes become orphaned. This scenario is separate from current
normal imports and is not evidence about any real user's database.

Validation of the independent probe:

```sh
node node_modules/typescript/bin/tsc --noEmit --target ES2022 \
  --lib ES2022,DOM,DOM.Iterable --types vite/client --module ESNext \
  --moduleResolution bundler --jsx react-jsx --skipLibCheck --esModuleInterop \
  --strict --noUnusedLocals --noUnusedParameters scripts/storage-benchmark/browser.tsx
node node_modules/eslint/bin/eslint.js --ext .mjs,.tsx scripts/storage-benchmark
```
