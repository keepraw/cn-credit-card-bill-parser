# Version-1 backup validation and restore policy

Both `credit-bill-manager-backup` and `credit-card-data-backup` remain supported.
The version-1 JSON data structure and ZIP entries are unchanged; newly exported
JSON uses compact whitespace and bounded UTF-8 chunks. Records require
their existing typed fields, valid enums and dates, unique nonempty identifiers,
finite safe-integer minor amounts, and valid statement/import references. Partial
historical settings with known keys remain supported. Structurally malformed
older backups are rejected rather than silently repaired or reinterpreted.

Restore adds absent primary keys. Matching existing records retain their user
metadata and provenance. A shared transaction key with conflicting financial
fields rejects the entire restore; statement identity and import-hash conflicts
also reject it. Complete newly restored statements keep their original decisions
and reconciliation. Additional rows in an existing or partial statement trigger
recalculation of its derived count and reconciliation. Restored
settings replace current settings, matching the previous version-1 behavior.
Repeat restoration is idempotent.

ZIP preview and restore validate the same records, manifest associations and
original bytes. Missing archived evidence, unmatched or duplicate manifest
records, extra files, unsafe paths and mismatched real SHA-256 hashes reject the
archive before persistence. Explicit fictional version-1 demo archives retain
their synthetic-hash compatibility exception. Hash-based filename fallback is
retained only when the match is unambiguous. Existing attachments must contain
the verified bytes; corrupted content under an existing key aborts restoration.

Records, settings, derived counts and originals commit in a single IndexedDB
transaction. Storage/quota errors roll back all stores. No hashing or ZIP work
occurs inside that transaction.

Limits: 256 MiB archive input/output, 256 MiB expanded content, 64 MiB per original,
128 MiB per JSON file, 20,000 ZIP entries and 1,000,000 total database records.
Exports enforce the same byte, entry-count and JSON complexity limits as restores,
including actual generated archive bytes. Export records come from one readonly
transaction; the manifest derives from that same immutable import snapshot.
Standard ZIP directories are checked before loading, and actual decompression is
bounded independently of advertised sizes. ZIP64 and multi-disk archives are
rejected; the application's supported archive size never needs those formats.

JSON is checked before JSON.parse: maximum nesting 64, 8,000,000 lexical tokens
and 2,000,000 containers, followed by existing typed record validation. This also
bounds small-byte scalar/container bombs. UTF-8 must decode without replacement.
The exporter checks the same structural budget.

The 128 MiB JSON budget accommodates the measured 100k historical v1 pretty
backup (113.056 MiB); compact encoding retains all fields while reducing export
copies. Originals are decoded sequentially, at most 64 MiB each, with retained
unique entries plus JSON bounded by the 256 MiB expansion budget. JSON parsing
still materializes a validated object graph before writes. UTF-16 text, object
overhead, the current ledger and IndexedDB clones need additional memory; byte
and structure caps are not a hard heap quota. The separate Chromium test records
RSS and actual 100k round trips. This is a desktop workload, not a guarantee on
every low-memory device.

ZIP output uses bounded chunks rather than a second archive-sized output array.
Hash checking and JSON/ZIP decoding finish before the atomic write transaction.
Transaction lookup and insertion use batches of 2,000 requests in that same
transaction; a late attachment/quota error still rolls back rows and settings.

Review decisions remain part of transaction records. Separate free-text review
notes are intentionally not added to version 1: existing exports never contained
them. Notes already stored locally remain untouched by restoration. A future
version should explicitly include notes with transaction references, support
version-1 readers during migration, and define note conflict handling. Until
then, version-1 exports do not back up free-text notes; the Settings UI states
this limitation.

### Follow-up data-protection task (not solved in this change)

V1 自由文本复核备注无法跨设备恢复是已知限制，不得描述为已经解决：

- 现状：`reviewNotes` 独立存储，不在 V1 JSON 或 ZIP 的恢复载荷内；本轮仅保证已有 notes 在恢复旧备份时不丢失，全新 profile 无法从 V1 找回未被导出的 notes；ZIP 附件 `importedAt` 在全新恢复时按旧合同重建，已有恢复与升级仍要求时间戳完全不变。
- 后续需要独立任务设计明确版本的备注备份合同（交易引用、版本迁移、冲突处理与旧版读取兼容），并在 Settings UI 与发布说明中保持提示；在该合同落地前，任何“备份完整”的表述均不含自由文本备注。
