# Versioned backup validation and restore policy (V1 + V2)

Both `credit-bill-manager-backup` and `credit-card-data-backup` remain supported.
New JSON exports use backup version 2. New ZIP exports carry the same V2 ledger
information in `database.json`. The ZIP manifest stays at version 1; the archive
envelope is unchanged beyond the versioned database payload.

## V2 schema

V2 keeps every V1 financial field, fingerprint, occurrence, amount, currency,
review decision, statement association, import provenance and settings byte
semantics, plus independent `reviewNotes`:

```json
{
  "format": "credit-card-data-backup",
  "version": 2,
  "exportedAt": "2026-01-01T00:00:00.000Z",
  "statements": [],
  "transactions": [],
  "imports": [],
  "reviewNotes": [
    { "transactionId": "tx-1", "note": "exact user text 🎉 中文", "updatedAt": "2026-01-02T00:00:00.000Z" }
  ],
  "settings": null
}
```

- `reviewNotes` is required in V2 (possibly empty), sorted by `transactionId`
  for stable output. Note content is stored only here, never duplicated inside
  transaction records.
- Each note preserves `transactionId`, exact `note` content (Unicode, Chinese,
  punctuation, line breaks, non-ASCII) and `updatedAt`.
- Validation: `transactionId` uses the same nonempty identifier rules as other
  IDs; `note` must be a non-empty, non-whitespace-only string up to 10,000
  characters; `updatedAt` must be a valid ISO timestamp; `transactionId`s must
  be unique.
- Reference policy: orphaned notes (no matching transaction in the payload)
  are valid and preserved. Exports include every stored note including orphans
  and never assume orphans belong to demo data. Restores insert orphans as
  recoverable user text rather than dropping them. Demo filtering uses only
  explicit `isDemo` flags, never note presence.
- Malformed, duplicate, mistyped, oversized or contradictory V2 payloads are
  rejected rather than silently repaired. A V1 payload carrying `reviewNotes`,
  a V2 payload missing `reviewNotes`, and any `version` other than 1 or 2 are
  rejected.

## Version detection and compatibility

- `version: 1` without `reviewNotes`: legacy backup. Both format names remain
  readable in JSON and inside ZIP `database.json`.
- `version: 2` with `reviewNotes`: current backup.
- V1 files can never reconstruct notes that were never exported. V1 restores
  preserve all existing local notes unchanged; V1 restores into a fresh profile
  invent no notes.
- V2 exports preserve notes; V2 restores recover them into fresh profiles.
- No IndexedDB schema migration was introduced for V2. The portable backup
  format advances independently from the Dexie V3 index layout.

## Note conflict and restore rules

Financial preservation takes priority over convenience:

- Incoming note absent locally: insert it with original content and timestamp.
- Existing note with identical content: preserve the existing row (including its
  timestamp). Repeated restoration is idempotent and creates no duplicates.
- Same `transactionId` with conflicting content: reject the entire restoration.
  Never last-write-wins, never compare `updatedAt` to overwrite.
- V1 restore: leave every local note untouched.
- Absence of a note in the payload never deletes an existing local note.

A shared transaction key with conflicting financial fields, statement identity
conflicts and import-hash conflicts continue to reject the entire restore, as in
V1. Matching existing financial records retain their user metadata and
provenance. Complete newly restored statements keep their original decisions and
reconciliation; additional rows in an existing or partial statement trigger
recalculation of derived counts and reconciliation. Restored settings replace
current settings. Repeat restoration is idempotent.

## Atomicity and backup safety

All restored ledger changes commit atomically in one IndexedDB transaction
covering transactions, statements, imports, review notes, settings and restored
original attachments (where applicable). JSON restores cover the first five;
ZIP restores cover all six. If any operation fails — including a late note,
transaction or attachment write — the entire restore rolls back.

Expensive JSON parsing, ZIP decompression, structural validation and SHA-256
verification complete before entering the write transaction. No hashing or ZIP
work occurs inside that transaction. Transaction and note lookup/insertion use
batches of 2,000 requests in that same transaction.

Exports obtain mutually consistent ledger records and notes from one readonly
transaction; the manifest derives from that same immutable import snapshot.
This avoids torn backup states from concurrent edits.

Existing PR #27 protections are unchanged: input-size limits, JSON complexity
budgets, ZIP entry validation, path safety, expansion limits and SHA-256
verification. Resource budgets were not weakened for V2; notes count toward the
existing 1,000,000 total-record budget (statements + transactions + imports +
reviewNotes) plus the 10,000-character per-note bound. The existing byte,
entry-count and JSON complexity limits apply identically to V2.

Limits: 256 MiB archive input/output, 256 MiB expanded content, 64 MiB per
original, 128 MiB per JSON file, 20,000 ZIP entries and 1,000,000 total database
records (including review notes). JSON is checked before `JSON.parse`: maximum
nesting 64, 8,000,000 lexical tokens and 2,000,000 containers. UTF-8 must decode
without replacement. Standard ZIP directories are checked before loading;
actual decompression is bounded independently of advertised sizes. ZIP64 and
multi-disk archives are rejected.

ZIP preview and restore validate the same records, manifest associations and
original bytes. Missing archived evidence, unmatched or duplicate manifest
records, extra files, unsafe paths and mismatched real SHA-256 hashes reject the
archive before persistence. Explicit fictional demo archives retain their
synthetic-hash compatibility exception. Hash-based filename fallback is retained
only when the match is unambiguous. Existing attachments must contain the
verified bytes; corrupted content under an existing key aborts restoration.

## JSON / ZIP behavior

- JSON contains ledger information (including V2 notes) but not raw evidence files.
- ZIP includes available original evidence under the existing best-effort policy
  (`indexeddb` vs `missing`); missing historical attachments are never fabricated.
- Existing V1 archives remain readable in both preview and restore paths.
- Existing ZIP manifest and evidence integrity rules remain enforced.
- Preview reports the backup version, review-note count and attachment gaps.
  Restore messages state how many transactions, statements, notes and original
  files were recovered, and call out V1 note limitations explicitly.
- Backup files are local unencrypted files, not secure encrypted cloud backups.
  The Settings UI states this.

## Follow-up notes (solved by V2)

V2 closes the known V1 gap: independent free-text `reviewNotes` are now
exported and restored across devices with exact preservation. V1 files still
cannot restore notes that were never exported. ZIP attachment `importedAt` in
fresh restores continues to follow the existing V1 restore contract
(reconstructed when missing); existing restores and migrations still require
stored timestamps to remain exact.
