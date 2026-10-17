# Keepraw-Ledger Comprehensive Repository Audit

**Audit date:** 2026-10-17 (Asia/Shanghai)
**Repository:** [keepraw/keepraw-ledger](https://github.com/keepraw/keepraw-ledger)
**Audited `main` SHA:** `98d6ead1852b0134c560b39db04b33e8ae10d7a2`
**Audit branch:** `audit/full-repository-2026-10`
**Scope:** Read-only engineering audit; this change adds this report only.

## 1. Executive Summary

The audit examined the current `main` commit identified above, not an unpushed local tree. The repository is a local-first React/TypeScript credit-card ledger with browser-side parsing and IndexedDB persistence. The strongest existing controls are integer-minor-unit money handling, explicit parsing and reconciliation states, exact-field transaction deduplication, validated V1/V2 backup input, atomic restore transactions, selective data cleanup, and a deployment workflow that publishes the artifact built and validated by the same successful run.

**Findings:** **0 P0, 0 P1, 2 P2, and 1 Recommendation.** No evidence was found of an incorrect financial total, silent loss of a real transaction, broken database upgrade, partial backup restore, or exploitable frontend injection in the reviewed paths. Two bounded issues are supported by evidence:

1. **Demo Mode review notes cross the real-data persistence boundary.** A synthetic Chromium reproduction showed that a note saved against an in-memory demo transaction is written to the production `reviewNotes` IndexedDB store, remains after Demo Mode is turned off, and is included in a JSON V2 backup even though no transaction row was persisted. This is a data-lifecycle/isolation defect, not a demonstrated change to financial totals.
2. **The 100k transaction list still performs whole-set filtering and sorting on the main thread.** Only 50 rows are rendered, but filtering and sorting operate on the full list. An archived deterministic benchmark measured a median 486.5 ms for a 100k description sort; the benchmark's `TransactionsPage.tsx` source hash matches the audited file. The rest of the historical benchmark stack is not identical to this SHA, so the measurement is a scale indicator rather than a current full-stack performance certification.

The sole Recommendation is to add a carefully tested Content-Security-Policy defense-in-depth control at the hosting boundary. The observed public response had no CSP header, but no current XSS sink or exploit was identified.

At the time checked, `main` had a successful GitHub Actions Validation run, a non-expired `github-pages` artifact, and a successful Pages deployment for the same SHA; the public site returned HTTP 200. The local audit also passed typecheck, lint, the full unit suite, build, high-severity dependency audit, and Chromium E2E. These are positive engineering signals, not proof that all bank formats, browsers, devices, or financial edge cases are defect-free. Users should continue to reconcile imported results against official bank records.

## 2. Audit Baseline and Scope

### Baseline and environment

- The GitHub remote was freshly queried before review. `main` resolved to `98d6ead1852b0134c560b39db04b33e8ae10d7a2`, matching the supplied reference SHA. A second remote SHA check at the end of the code review returned the same value.
- The audit branch was created from a fresh clone of `origin/main`; the initial worktree was clean. No local changes from other working directories were used.
- The repository inventory contained **191 tracked files**. The inventory covered the application source, tests, E2E tests, scripts, bank golden fixtures, documentation, benchmark artifacts, and workflow configuration. High-risk source and test modules were reviewed by domain rather than by sampling only recent PRs.
- Local environment: Ubuntu 24.04, Node.js `v24.19.0`, npm `11.17.0`, Playwright Chromium. The repository's GitHub workflow uses Node.js 22; local/CI runtime differences are noted in the limitations.
- Recent PRs #27–#31 were consulted only to understand the current design and historical test/benchmark claims. Findings below are based on the actual audited tree at `98d6ead…d7a2`, not a repeat review of those PR approvals.

### CI, Pages artifact, and deployment snapshot

- [Validation run #39007313053](https://github.com/keepraw/keepraw-ledger/actions/runs/39007313053), for `98d6ead1852b0134c560b39db04b33e8ae10d7a2`, completed successfully. The `web` job's typecheck, lint, unit tests, build, `npm audit --audit-level=high`, Chromium E2E, and validated-artifact upload steps all succeeded.
- The run produced one non-expired `github-pages` artifact (870,447 bytes). The dependent `deploy` job completed successfully. Pages deployment `7135457084` targeted the same SHA and reported `state: success`, with environment URL `http://ledger.keepraw.com/`.
- A read-only request to [https://ledger.keepraw.com/](https://ledger.keepraw.com/) returned HTTP/2 200; its `Last-Modified` value matched the 2026-10-17 deployment window. This confirms the observed deployment snapshot, not a continuing availability guarantee.
- At the same request time, the response had no `Content-Security-Policy` header. This is recorded only as a defense-in-depth Recommendation; no exploit was demonstrated.

### Scope and method

The review prioritized financial correctness, recovery, data lifecycle, security/privacy, performance, and maintainability in that order. It included:

- Core money, date, identity, deduplication, ingest, classification, data-quality, analytics, and reconciliation logic.
- The six registered bank parser flows (BOC, ICBC, ABC, CCB, BOCOM, CITIC), parser registry/extraction/HTML handling, and the three supported historical XLSX adapters.
- Dexie schema versions, repository transactions, migrations, import/edit paths, Demo Mode, review notes, attachments, data deletion, JSON/ZIP validation and recovery.
- React state/UI paths relevant to import, review, ledger display, Dashboard, and large-history behavior; unit/integration/E2E tests; benchmark methodology and artifacts; dependency manifest/lockfile; GitHub Actions and Pages deployment configuration.
- README and relevant backup-safety, evidence-lifecycle, transaction-identity, historical-migration, dependency-security, and benchmark documentation.

The review was read-only with respect to application source, schema, tests, dependencies, and CI. No real or private statement was opened, imported, uploaded, or used. Dynamic verification used only a fresh isolated browser profile and a synthetic note marker. The report is an engineering assessment, not a formal proof, financial certification, penetration test, or guarantee of physical erasure from browser-managed storage.

## 3. Architecture Overview

Keepraw-Ledger is a static, local-first React 18 / TypeScript application built with Vite. It has no application backend or server-side financial database. The major runtime dependencies include Dexie/IndexedDB, JSZip, `pdfjs-dist`, `postal-mime`, and SheetJS (`xlsx`); tests and builds use Vitest, Playwright, TypeScript, ESLint, and Vite. The repository describes this boundary in the [README](https://github.com/keepraw/keepraw-ledger/blob/98d6ead1852b0134c560b39db04b33e8ae10d7a2/README.md).

### Financial-data flow

1. The user supplies a PDF or EML statement, or a recognized historical XLSX workbook. Parser selection is explicit; parsing and validation run in the browser. The six bank parser families and supported legacy schemas are finite, documented formats rather than a promise to accept every bank template.
2. Parser results pass through core ingest, money/date validation, identity and occurrence assignment, duplicate review, classification, and reconciliation logic. `AppStore` coordinates imports and serializes state-changing operations; persisted rows are written through the repository layer.
3. Dexie defines six IndexedDB stores: `statements`, `transactions`, `imports`, `settings`, `reviewNotes`, and `attachments`. Transactions and statements are the financial ledger; review notes are keyed independently by transaction ID; raw evidence is stored separately by file hash when the browser permits it. See [`db.ts`](https://github.com/keepraw/keepraw-ledger/blob/98d6ead1852b0134c560b39db04b33e8ae10d7a2/web/src/db/db.ts#L48-L85).
4. Analytics consume ledger rows and statement trust state. Dashboard totals use integer minor units and explicit currency/type/review rules; non-CNY settlement rows are retained but are not converted into RMB totals.
5. JSON V2 contains ledger records, settings, and independent review notes; ZIP V2 adds available original files and a manifest. Parsing, structural/resource validation, file/hash checks, and identity/conflict checks precede a single IndexedDB write transaction. The recovery design is documented in [`repository.ts`](https://github.com/keepraw/keepraw-ledger/blob/98d6ead1852b0134c560b39db04b33e8ae10d7a2/web/src/db/repository.ts#L178-L265) and [`archive.ts`](https://github.com/keepraw/keepraw-ledger/blob/98d6ead1852b0134c560b39db04b33e8ae10d7a2/web/src/backup/archive.ts#L147-L230).

### Data-integrity boundaries and maintainability

- Core money and identity logic are separated from React presentation; parsers feed typed ingest results rather than performing persistence themselves.
- A key integrity boundary is the distinction between a candidate fingerprint and a true duplicate: deduplication compares a JSON-encoded tuple of the fingerprint and full business fields, then allocates occurrences. The reviewed path does not silently merge on hash equality alone.
- Database upgrades retain object stores and primary keys; V3 removes unused secondary indexes rather than rewriting stored business rows. Cleanup and restore paths use Dexie transactions.
- Demo transactions are generated in memory and are not part of the real transaction snapshot. The note-writing path is not similarly mode-isolated; this mismatch is AUD-001.
- The main maintainability risk is that the application keeps complete snapshots in React state and performs list filtering/sorting in the browser. Pagination limits rendered rows, not the amount of data processed; this is the basis for AUD-002, not evidence that the local-first architecture should be replaced.

## 4. Audit Coverage Matrix

| Domain | Key code/tests examined | Validation performed | Coverage/result | Confirmed finding count | Residual risk |
|---|---|---|---|---:|---|
| Financial correctness | `web/src/core/{money,types,analytics,reconcile,reconciliation,dates}.ts`; `financialIntegrity`, `currencyPersistence`, `excelMoney`, reconciliation tests | Full Vitest suite; Chromium financial-integrity and Excel-money E2E | Detailed review of minor-unit parsing, signed legs, CNY inclusion, trust filters, installment/refund/credit handling; no current incorrect-total path confirmed | 0 | Synthetic statements do not prove every issuer template or future edge case; real statements were not used |
| Transaction identity / deduplication | `core/{identity,dedupe,ingest,migrationAudit}.ts`; identity, cross-source, pipeline, golden tests | Full Vitest; 100k identity smoke test and 100k Chromium/IndexedDB synthetic E2E | Checked ID/fingerprint/occurrence, exact-field matching, repeated legitimate rows, suspected-duplicate review; collision concern not elevated because current dedup path compares the complete tuple | 0 | Hash collisions remain theoretically possible; no silent-loss path was found in the reviewed allocation/matching logic |
| Import and parsing | `web/src/parsers/`, `web/src/importers/`; six bank fixtures/tests, parser registry, legacy-import tests | Full Vitest and Chromium E2E; 18.5k synthetic legacy-import test | Registered BOC/ICBC/ABC/CCB/BOCOM/CITIC paths and recognized XLSX adapters reviewed; invalid/unknown inputs have explicit failure paths | 0 | No independent testing against current live issuer formats; real-statement acceptance tests were skipped |
| IndexedDB and migration | `db/db.ts`, `db/repository.ts`, `AppStore.tsx`; upgrade, migration, ledger-state tests and upgrade E2E | Full Vitest and Chromium database-upgrade E2E | V1/V2→V3 store/key preservation, transaction scopes, serialized writes, rollback and failure paths reviewed | 0 | No actual user profile, cross-tab stress, or real quota exhaustion test |
| Backup and recovery | `web/src/backup/{json,validation,archive,zipSafety}.ts`, repository persistence, backup safety/V2/large-backup tests | Full Vitest, backup/restore E2E, static ordering/transaction review | V1/V2 compatibility, review-note conflicts, ZIP paths/limits, hashes, attachments, idempotence, and rollback protections reviewed; no confirmed defect | 0 | No full 100k restore/peak-memory run at this exact SHA; no exhaustive differential fuzzing of all ZIP parser edge cases |
| Deletion and Demo isolation | `clearAllData`, `purgeDemoRows`, `clearDemoData`, `AppStore`, `ReviewPage`; demo-isolation/residue/evidence tests | Full Vitest plus isolated synthetic Chromium reproduction and JSON V2 export check | Deletion transactions/shared-file rules reviewed; Demo Mode review note crosses into the real `reviewNotes` store and backup | **1 P2** | Note is user text, not a persisted financial row; it can be cleared by explicit real-data cleanup, but is not isolated on Demo exit |
| Frontend security / privacy | React UI, HTML/PDF/file parsing, exports, backup input validation, dependency lockfile, `web/index.html`, deployed response | Static sink/network scan, `npm audit --audit-level=high`, public response-header check | No dangerous HTML sink or current XSS path confirmed; no npm high-level audit finding; observed hosted response lacked CSP | **1 Recommendation** | No penetration test; same-origin scripts/extensions/device malware remain outside the app boundary; CSP absence is not an exploit |
| Performance | Transactions list, analytics, store/snapshot behavior, legacy import, benchmark docs/raw JSON | Full Vitest, Chromium E2E including 100k synthetic IndexedDB scenario, static complexity analysis, historical benchmark/source-hash comparison | Current code still filters/sorts the full list; historical 100k UI timings are disclosed and scoped, not presented as a current full-stack certification | **1 P2** | No low-memory-device or exact-SHA UI heap/latency campaign; backup/archive code differs from historical stress benchmark |
| Maintainability | Full application module inventory, core/UI/store boundaries, docs, scripts and test layout | Repository inventory plus architecture and dependency-flow review | Responsibilities are generally separated; no rewrite-level architecture concern or independent maintainability defect supported by evidence | 0 | Whole-app manual architectural review cannot establish absence of all coupling or future maintenance costs |
| Tests / CI / deployment | `web/tests/`, `web/e2e/`, `.github/workflows/ci.yml`, GitHub run/artifact/deployment APIs | Local full validation; live remote status/artifact/deployment check | Main Validation, Pages artifact and dependent deployment all succeeded for the exact baseline SHA; no CI bypass or artifact substitution found | 0 | Deployment ordering has a small unavoidable interval after the current-SHA check; only the observed run is certified here |

## 5. Findings

### P0 — Critical

**None identified.** No evidence-supported critical financial integrity, loss, recovery, or security defect was found in the audited paths.

### P1 — High

**None identified.** The confirmed issues below are bounded lifecycle/performance defects and do not meet the P1 threshold on the evidence available.

### P2 — Medium / Low

#### AUD-001 — Demo Mode review notes persist in the real IndexedDB store and V2 backups

- **Severity:** P2
- **Confidence:** Confirmed (reproduced with synthetic data in isolated Chromium)
- **Affected files:** [`ReviewPage.tsx` (Demo warning, note editor, and conditional note display)](https://github.com/keepraw/keepraw-ledger/blob/98d6ead1852b0134c560b39db04b33e8ae10d7a2/web/src/ui/pages/ReviewPage.tsx#L273-L330); [`AppStore.tsx` (unconditional `saveNote` path)](https://github.com/keepraw/keepraw-ledger/blob/98d6ead1852b0134c560b39db04b33e8ae10d7a2/web/src/app/AppStore.tsx#L319-L327); [`AppStore.tsx` (Demo rows are an in-memory snapshot)](https://github.com/keepraw/keepraw-ledger/blob/98d6ead1852b0134c560b39db04b33e8ae10d7a2/web/src/app/AppStore.tsx#L385-L401); [`repository.ts` (note persistence and V2 export)](https://github.com/keepraw/keepraw-ledger/blob/98d6ead1852b0134c560b39db04b33e8ae10d7a2/web/src/db/repository.ts#L99-L110) and [V2 note export](https://github.com/keepraw/keepraw-ledger/blob/98d6ead1852b0134c560b39db04b33e8ae10d7a2/web/src/db/repository.ts#L147-L164).
- **Trigger conditions:** Demo Mode is enabled; a user opens Review → Transaction Review, enters a note for the first flagged in-memory demo transaction, and selects **Save note**. The user later disables Demo Mode or exports a JSON V2 backup.
- **Evidence:** The page supplies a demo transaction ID to `saveNote`; `AppStore.saveNote` calls `setReviewNote` without checking `demoMode` or confirming a persisted real transaction exists. `setReviewNote` writes directly to `db.reviewNotes`. Demo transactions are supplied from `getDemoSnapshot()` while the real snapshot is held separately. `exportDataBackup()` exports every row in `reviewNotes`, including orphans. The repository's Demo isolation test asserts that demo statements/transactions/imports stay out of Dexie, but does not exercise saving a Demo review note ([test](https://github.com/keepraw/keepraw-ledger/blob/98d6ead1852b0134c560b39db04b33e8ae10d7a2/web/tests/demoIsolation.test.ts#L44-L61)); the existing E2E review flow also does not cover this case ([test](https://github.com/keepraw/keepraw-ledger/blob/98d6ead1852b0134c560b39db04b33e8ae10d7a2/web/e2e/app.spec.ts#L124-L147)).
- **Synthetic reproduction:** In a new Playwright Chromium context with no real records, save the marker `AUDIT-SYNTHETIC-ONLY-demo-note` in Demo Mode. IndexedDB contained **0 transaction rows and 1 review-note row**. After turning Demo Mode off, IndexedDB still contained 0 transaction rows and the same note. The UI-exported JSON V2 backup included the note. No real statement, note, or financial data was used. The note is not necessarily visible in Review after Demo exit when there are no flagged real transactions, because the notes panel is nested under the flagged-transaction condition; this makes the persisted orphan easier to miss.
- **Expected behavior:** Demo-only review content should remain isolated from the real ledger and ordinary backups, or be stored in an explicitly separate Demo-only store with a clear lifecycle. A saved note should not silently become an unlinked real-ledger record.
- **Actual behavior:** A note keyed to a demo transaction is written to the production `reviewNotes` table. It is not automatically removed on Demo exit, can remain without a matching transaction, and is included in JSON V2 export.
- **Impact:** Orphaned user text pollutes the real ledger's note store and backup. The text could itself contain sensitive information. No transaction amount, count, or persisted financial row was changed in the reproduction; no external transmission was observed. `Clear Real Data` removes notes without a surviving demo transaction, but it is a manual cleanup action ([cleanup path](https://github.com/keepraw/keepraw-ledger/blob/98d6ead1852b0134c560b39db04b33e8ae10d7a2/web/src/db/repository.ts#L313-L335)).
- **Suggested remediation:** Enforce the Demo/real boundary at the persistence API: either keep Demo notes in memory/separate Demo state and omit them from real backups, or reject persisted note writes unless the transaction ID is a valid real-ledger transaction. A UI-only disabled control would not protect callers or queued operations.
- **Regression tests:** With a fresh isolated IndexedDB, save a note against a Demo transaction and assert that the real `reviewNotes` table and JSON/ZIP V2 exports remain unchanged; turn Demo Mode off and confirm no orphan remains. Also assert that a note for a real persisted transaction still saves, reloads, and round-trips through V2, and that clear/restore semantics remain atomic.
- **Limitations:** The issue was reproduced only with a synthetic note and empty synthetic ledger. The Review page explicitly says review results are saved in local IndexedDB; the defect is the lack of Demo provenance/isolation and resulting orphan/backup behavior, not the mere fact that data is stored locally. Cross-tab races and user-authored sensitive note contents were not tested.

#### AUD-002 — 100k transaction-list filtering and sorting remain unbounded main-thread work

- **Severity:** P2
- **Confidence:** Confirmed (current code path and archived measurement; environment-dependent user impact)
- **Affected files:** [`TransactionsPage.tsx`](https://github.com/keepraw/keepraw-ledger/blob/98d6ead1852b0134c560b39db04b33e8ae10d7a2/web/src/ui/pages/TransactionsPage.tsx#L12-L56); [`analytics.ts` filtering](https://github.com/keepraw/keepraw-ledger/blob/98d6ead1852b0134c560b39db04b33e8ae10d7a2/web/src/core/analytics.ts#L26-L36); [large-ledger benchmark report](https://github.com/keepraw/keepraw-ledger/blob/98d6ead1852b0134c560b39db04b33e8ae10d7a2/docs/benchmarks/large-ledger-optimization-report.md#L83-L110); [benchmark source metadata](https://github.com/keepraw/keepraw-ledger/blob/98d6ead1852b0134c560b39db04b33e8ae10d7a2/docs/benchmarks/large-ledger/after.json#L1-L23).
- **Trigger conditions:** A ledger near 100,000 transactions is open and the user searches, changes filters, or sorts by a text/date/amount field.
- **Evidence:** `applyFilters` scans the supplied full transaction array; the page then applies a further full-array search filter. `sortTransactions` clones and sorts the entire filtered array. Only after those operations does `rows.slice(...)` choose 50 rows to render. The archived deterministic benchmark reports, for 100k rows, median UI search of 134.5 ms and median UI description sort of 486.5 ms. The benchmark's recorded SHA-256 for `TransactionsPage.tsx` equals the audited file. However, its run was on benchmark commit `06800f20039bab2ebbc3cdb301d53645e8d1b699`; `AppStore`, `repository`, and archive source hashes differ from the audited SHA, so the report does not treat those figures as a full current-stack certification.
- **Expected behavior:** Normal list interactions should remain responsive at the project's supported large-history scale; visible-row pagination should not be mistaken for bounded compute.
- **Actual behavior:** Filtering and sorting are client-side over the complete list, with O(N) scans and O(N log N) sorting plus array copies. The 50-row page size reduces DOM work only.
- **Impact:** The archived reference run shows a noticeable delay—about half a second for a 100k description sort—on the recorded 5-vCPU Xeon test host. Slower or memory-constrained client devices may fare worse. No data corruption or financial miscalculation was observed.
- **Suggested remediation:** No architectural rewrite is warranted by this evidence. If 100k ledgers are a target workload, profile representative current builds and devices, then evaluate bounded/indexed filtering or off-main-thread sorting while preserving current sort order, filters, and full-history semantics.
- **Regression tests:** Retain deterministic synthetic 18k/100k datasets; verify full result parity, sort stability and financial semantics, and add an explicitly scoped browser interaction latency/memory budget. Keep expensive full-scale tests bounded and separate from routine CI if necessary.
- **Limitations:** The full 100k UI benchmark was not rerun on the entire current SHA, and no low-memory device or heap-pressure test was performed. The local 100k Chromium E2E scenario exercises ingest/identity/IndexedDB correctness, not the transaction-list UI. Archived timings are hardware- and browser-specific.

### Recommendation — Improvement

#### AUD-003 — Add a restrictive CSP as hosting-level defense in depth

- **Severity:** Recommendation (not a confirmed vulnerability)
- **Confidence:** Confirmed that the observed response lacked the header; no current exploit was established.
- **Affected files / surface:** [`web/index.html`](https://github.com/keepraw/keepraw-ledger/blob/98d6ead1852b0134c560b39db04b33e8ae10d7a2/web/index.html#L1-L17); deployed [https://ledger.keepraw.com/](https://ledger.keepraw.com/).
- **Trigger conditions:** A future XSS, compromised dependency/static asset, or unsafe content-rendering path is introduced.
- **Evidence:** A read-only `curl -fsSI https://ledger.keepraw.com/` on 2026-10-17 returned HTTP/2 200 without a `Content-Security-Policy` response header. The HTML includes a `no-referrer` meta policy but no CSP meta policy. Static review did not find `dangerouslySetInnerHTML`, direct `innerHTML` sinks, `eval`, or an equivalent untrusted-HTML rendering path; the EML parser strips dangerous elements/attributes.
- **Expected behavior:** The deployed static origin should apply a compatible CSP that limits executable/resource origins and blocks unnecessary object/embed or base-URL behavior, providing a containment layer if a future injection defect appears.
- **Actual behavior:** No CSP header was present in the sampled response. This is a missing defense-in-depth control only; the audit did not find an exploitable XSS.
- **Impact:** A future injection or compromised resource would have fewer browser-enforced constraints. No current sensitive-data exfiltration was demonstrated.
- **Suggested remediation:** Determine which CSP controls are supported by the chosen static-hosting boundary, add the narrowest compatible policy (including the PDF worker's legitimate needs), and verify the deployed response rather than assuming a repository meta tag covers header-only directives.
- **Regression tests:** Add a deployment-level header assertion and a browser smoke test that confirms required local app/PDF-worker resources work while unexpected external script/connect sources are blocked.
- **Limitations:** Only the public response at the audit timestamp was sampled; CDN/hosting configuration can change. CSP is not a substitute for safe rendering, dependency review, or browser/device security.

## 6. Validation and Test Evidence

| Command / evidence | Result | Notes |
|---|---|---|
| Fresh clone, fetch, checkout `audit/full-repository-2026-10`; `git rev-parse HEAD`; final `git ls-remote origin refs/heads/main` | Pass; all resolved to `98d6ead1852b0134c560b39db04b33e8ae10d7a2` | Initial worktree was clean. |
| `npm ci` in `web/` | Pass; 331 packages installed; 0 vulnerabilities reported during install | npm printed upstream package deprecation notices; no dependency was changed. |
| `npm run typecheck` | Pass | Local Node.js 24.19.0. |
| `npm run lint` | Pass with 0 errors, 2 warnings | Existing `no-console` warnings at `web/scripts/generate-golden.ts:91-92`. |
| `npm test -- --reporter=dot` | Pass: 42 test files passed, 1 skipped; 608 tests passed, 6 skipped | The skipped acceptance tests use the existing opt-in real-statement fixture policy. No real fixture was opened. |
| `npm run build` | Pass | Production Vite build completed. |
| `npm audit --audit-level=high` | Pass; 0 vulnerabilities reported | No `npm audit fix` or package update was run. |
| `npm run test:e2e` | Pass: 24 passed, 2 skipped | The two opt-in real-statement import tests were skipped. The 100,000 synthetic transaction Chromium/real-IndexedDB scenario passed in 18.8 seconds; this is test duration, not a UI-sort benchmark. |
| Synthetic Demo-note Chromium reproduction | Confirmed | Fresh isolated profile; 0 persisted transaction rows / 1 persisted review note after Demo save; after leaving Demo the note remained and was present in the UI-exported JSON V2 backup. The temporary synthetic download was removed; no script or test was committed. |
| `curl -fsSI --max-time 20 https://ledger.keepraw.com/` | HTTP/2 200 | Read-only availability/header sample; no CSP response header at that time. |
| `git diff --check` (after adding this report) | Pass | No whitespace errors. |
| Final `git status` / diff review | Only `docs/audits/2026-10-17-full-repository-audit.md` is tracked as a change | Generated `web/node_modules/`, `web/dist/`, and Playwright test output were ignored; no product code, test, lockfile, or workflow changes. |

The latest remote Validation run independently passed all configured CI steps and the Pages deployment for the baseline SHA. Local results complement, but do not replace, that remote evidence.

## 7. Performance and Scalability Assessment

### Current-audit measurements

- The full Vitest suite emitted a synthetic legacy-import measurement for 18,500 rows: preview 4,500 ms, plan 866 ms, write 730 ms, total 6,096 ms in the local test environment. This is a test-harness measurement, not a bank-file benchmark.
- Synthetic 50,000-row aggregation tests reported 22 ms for data-quality aggregation and 32 ms for reconciliation. A 100,000-existing / 100,001-incoming identity smoke test reported 1,814 ms.
- The Chromium E2E test wrote and read a 100,000-row synthetic ledger through real IndexedDB and verified 100,001 distinct IDs after overlap handling; the test completed in 18.8 seconds. Its objective is identity/storage correctness, not an isolated UI interaction or memory benchmark.
- The current transaction-list source scans and sorts complete arrays before taking a 50-row page; details and scale impact are recorded under AUD-002.

### Historical benchmark evidence (not represented as a new run)

The repository contains repeatable 18k/100k synthetic benchmark artifacts and an explanatory report. The archived after dataset is dated 2026-10-14 and identifies benchmark commit `06800f20039bab2ebbc3cdb301d53645e8d1b699`. Its `TransactionsPage.tsx` source hash matches the audited file; several other measured source hashes do not. It reported 100k UI search median 134.5 ms and description sort median 486.5 ms. The report also documents a historical 100k JSON restore around 22.8 seconds, ZIP restore around 27.9 seconds, and a measured Chromium aggregate RSS peak around 2.815 GiB with shared-page double counting caveats. Those restore/heap numbers are **not** claimed as current results because backup/archive code changed after that benchmark.

### Conclusions and unverified scale

- The tests and historical artifacts support functional operation on large synthetic datasets and identify the remaining full-list UI cost; they do not establish a universal 18k/100k performance guarantee.
- No full 100k JSON/ZIP export-and-restore or peak-memory stress campaign was run against the complete audited SHA. The documented historical limits (including whole-document JSON parsing, memory overhead, and browser-dependent storage) remain relevant, but current resource behavior should be measured before treating old timings as an SLA.
- No unbounded stress test, production data test, or low-memory device test was performed.

## 8. Positive Findings

1. **Money representation and validation:** monetary amounts are represented as integer minor units, with checks for unsafe numeric inputs and unsupported precision rather than silent precision guessing. Core tests cover signed amount legs and invalid monetary inputs. See [`money.ts`](https://github.com/keepraw/keepraw-ledger/blob/98d6ead1852b0134c560b39db04b33e8ae10d7a2/web/src/core/money.ts#L108-L143).
2. **Explicit financial semantics:** types distinguish purchases, refunds, payments, fees, interest, and installment originals/payments. Analytics use CNY settlement rows for RMB totals, exclude rejected rows where appropriate, and filter unreconciled statements by default while treating imported historical statements as an explicit exception. See [`analytics.ts`](https://github.com/keepraw/keepraw-ledger/blob/98d6ead1852b0134c560b39db04b33e8ae10d7a2/web/src/core/analytics.ts#L54-L105) and [trust filtering](https://github.com/keepraw/keepraw-ledger/blob/98d6ead1852b0134c560b39db04b33e8ae10d7a2/web/src/core/analytics.ts#L123-L153).
3. **Deduplication does not rely on the hash alone:** `exactKey()` includes the fingerprint and full identifying/business fields. The matching path consumes only exact matches; same-day/amount but non-identical rows are candidates for human review, not automatic deletion. See [`dedupe.ts`](https://github.com/keepraw/keepraw-ledger/blob/98d6ead1852b0134c560b39db04b33e8ae10d7a2/web/src/core/dedupe.ts#L67-L75) and [duplicate matching](https://github.com/keepraw/keepraw-ledger/blob/98d6ead1852b0134c560b39db04b33e8ae10d7a2/web/src/core/dedupe.ts#L118-L172).
4. **Parser and data-quality boundaries:** supported parsers are registered explicitly; malformed/unrecognized input is not reported as a successful import. EML HTML is parsed inertly and strips unsafe elements/attributes rather than rendering source HTML ([`html.ts`](https://github.com/keepraw/keepraw-ledger/blob/98d6ead1852b0134c560b39db04b33e8ae10d7a2/web/src/parsers/html.ts#L11-L26)).
5. **Recovery protections:** JSON pre-validation limits bytes, nesting, tokens, containers, and record shape. ZIP handling checks archive paths/counts/declared and actual extracted size; available raw evidence is hash-checked. Restore merges by stable identifiers and performs conflict checks before writes in a transaction; tests cover rollback and idempotence.
6. **Database and deletion semantics:** V3 preserves existing stores/primary keys while removing unused indexes. Clear operations and legacy demo-row cleanup use transaction scopes across related tables; shared real/demo attachment hashes receive explicit protection. The remaining Demo-note defect is separate from these protections.
7. **Deployment provenance:** pull requests run validation but do not upload Pages artifacts; deployment is gated on the successful Web job and reuses its artifact. Main deployment is serialized and checks whether the validated commit is still current before deploying. See [`.github/workflows/ci.yml`](https://github.com/keepraw/keepraw-ledger/blob/98d6ead1852b0134c560b39db04b33e8ae10d7a2/.github/workflows/ci.yml#L1-L90).
8. **Privacy boundaries are documented:** the application is local-first and does not have a ledger backend. The app does not encrypt exported backups, and browser storage is not an encrypted vault; the README documents these limitations rather than claiming server-side protection or physical erasure.

## 9. Recommended Remediation Roadmap

### P0 — Immediate

- **None.** No evidence supports a P0 response or emergency change.

### P1 — Priority independent fix

- **None.** No confirmed P1 issue was identified. Do not create urgency beyond the demonstrated impact.

### P2 — Normal-priority follow-up PRs

1. **AUD-001 (first priority):** isolate Demo review notes from the real `reviewNotes` store and real backup contract, with the repository-layer guard and integration/E2E coverage described above. Preserve real transaction note persistence and restore atomicity.
2. **AUD-002:** if 100k histories remain an intended workload, profile the current full stack on representative supported devices. Only then decide whether to add indexed/paged querying or move comparison work off the main thread. Any change must preserve filter behavior, stable ordering, transaction identity, and financial totals.

### Recommendation — Improvement

- **AUD-003:** add a compatible CSP at the static hosting boundary and verify the deployed response and PDF worker behavior. This is defense in depth, not a blocker based on an existing exploit.

No code fix, schema change, dependency update, test modification, CI change, or automatic PR merge is included in this audit. Follow-up fixes should be separate reviewed PRs.

## 10. Residual Risks and Audit Limitations

- The two real-statement acceptance tests/files are opt-in and were not run or opened; six unit acceptance cases and two E2E real-statement cases were skipped. Bank parser conclusions therefore rely on synthetic fixtures, regression tests, and documented supported formats—not live/current issuer statements.
- E2E coverage was Chromium on this Linux environment. Firefox, WebKit/Safari, mobile browsers, multiple browser profiles, cross-tab races, private browsing, and actual device storage eviction were not tested.
- No full 100k backup/restore or low-memory-browser peak-heap test was run at the audited SHA. Historical measurements have explicit source/runtime scope and are not substituted for current measurements.
- Dependency audit reports known advisories at the time and threshold used; `npm audit --audit-level=high` does not establish that all dependency or supply-chain risks are absent. Dependency versions were not changed.
- No application penetration test, malicious-input fuzzing campaign, formal verification, or adversarial PDF/ZIP parser differential test was performed. Static review cannot prove that every untrusted-input path is safe.
- IndexedDB is origin-local browser storage, not application-level encryption. Browser extensions, malware, shared device accounts, downloaded copies, and physical-media recovery are outside the app's control; this report does not claim data erasure or confidentiality guarantees beyond the reviewed code/documentation.
- GitHub Actions and Pages status, artifact, deployment state, and public HTTP response were snapshots taken during this audit. They can change after this report is written.

This report evaluates the software at `98d6ead1852b0134c560b39db04b33e8ae10d7a2`. It is not an absolute safety certification and should not replace statement reconciliation, independent backups, or future review of material code changes.
