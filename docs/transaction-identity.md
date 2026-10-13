# Occurrence-aware import compatibility

The fingerprint algorithm, database schema and historical IDs are unchanged.
Fingerprints are candidate keys, not proof of identity: exact descriptions and
business fields must agree. Distinct original amounts or currencies are retained
even when their settlement amount and normalized fingerprint agree.

An import consumes at most one stored occurrence for each matching incoming row.
The resulting count is the maximum of the stored and incoming counts. Matched
rows keep their stored IDs; unmatched rows use the original occurrence ID when
free, otherwise the next free occurrence suffix. Reordering descriptions that
normalize to the same fingerprint cannot overwrite another transaction.

Both bank and legacy imports use this rule. Legacy confirmation rechecks the
fresh snapshot, and preserves existing statement summaries. Existing categories,
review decisions, flags and provenance are never written back during import.
New rows are added rather than upserted: a concurrent primary-key collision
aborts the import transaction instead of overwriting financial data. The user
can retry the import against the updated snapshot.

Known successfully imported files are skipped even after description edits.
Failed or unsupported records do not block a later successful retry. No migration
is needed. This change cannot reconstruct transactions lost by earlier imports;
recovery requires a separately reviewed overlapping source with a different hash,
or an explicit recovery workflow for the already recorded file.
Different descriptions or conflicting business fields remain distinct and are
flagged for review. Historical legacy/parser differences in posting dates or
transaction types remain subject to the existing migration audit; they are not
silently reinterpreted. Separate disjoint statements with identical business
fields provide no evidence of whether a row is new or overlapping, so count
matching retains the existing conservative overlap policy.

Matching uses maps and sets with O(stored + incoming) expected time and memory.
Suspected-duplicate descriptions are capped at three examples per incoming row
to avoid quadratic output for large ambiguous groups. The synthetic 100,000-row
smoke test reports elapsed time without a brittle CI time limit assertion.
