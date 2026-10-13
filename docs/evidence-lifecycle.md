# Sensitive-data lifecycle

Clearing real data removes real statements, transactions, import metadata,
original-file attachments and review notes in one IndexedDB transaction.
Settings are retained. Legacy rows without a demo marker are treated as real.
Orphaned evidence and notes are also removed because they have no reliable demo
provenance. Evidence shared with a surviving demo import is retained, as are
notes on surviving demo transactions. Clearing all data removes every sensitive
row. Clearing only demo data preserves real evidence and notes.

Each batch result owns its evidence buffer, hash and filename. A file-read
failure gets one retry; the resulting buffer is both hashed and retained before
document extraction. Parser failures retain those same bytes without rereading.
Unreadable files receive distinct unavailable identifiers and no attachment.
There is no array-index association between results and evidence.

Parsed data and failed-import records are persisted in one transaction. Evidence
retention remains best effort so quota failures do not discard valid parsed
transactions. Missing evidence is reported in the import message and derived
from the attachment table in the archive manifest. A quota failure may prevent
the optional message update; the manifest still accurately reports missing
evidence. No database schema or backup format changes are required.
