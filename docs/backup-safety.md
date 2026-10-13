# Version-1 backup validation and restore policy

Both `credit-bill-manager-backup` and `credit-card-data-backup` remain supported.
The JSON and ZIP formats and IndexedDB schema are unchanged. Records now require
their existing typed fields, valid enums and dates, unique nonempty identifiers,
finite safe-integer minor amounts, and valid statement/import references. Partial
historical settings with known keys remain supported. Structurally malformed
older backups are rejected rather than silently repaired or reinterpreted.

Restore adds absent primary keys. Matching existing records retain their user
metadata and provenance. A shared transaction key with conflicting financial
fields rejects the entire restore; statement identity and import-hash conflicts
also reject it. Existing bank summaries are preserved, and added transactions
trigger recalculation of derived statement counts and reconciliation. Restored
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

Limits: 128 MiB compressed input, 256 MiB expanded content, 64 MiB per original,
32 MiB per JSON file, 20,000 ZIP entries and 1,000,000 total database records.
Standard ZIP directories are checked before loading, and actual decompression is
bounded independently of advertised sizes. ZIP64 and multi-disk archives are
rejected; the application's supported archive size never needs those formats.
Large backups still need browser memory for validated contents before commit.

Review decisions remain part of transaction records. Separate free-text review
notes are intentionally not added to version 1: existing exports never contained
them. Notes already stored locally remain untouched by restoration. A future
version should explicitly include notes with transaction references, support
version-1 readers during migration, and define note conflict handling. Until
then, version-1 exports do not back up free-text notes; the Settings UI states
this limitation.
