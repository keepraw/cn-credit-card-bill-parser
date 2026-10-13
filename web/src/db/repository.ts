import type { ExistingSnapshot, IngestResult } from '../core/ingest'
import type { ImportRecord, Statement, Transaction } from '../core/types'
import { type AttachmentRow, db } from './db'

export interface Snapshot {
  statements: Statement[]
  transactions: Transaction[]
  imports: ImportRecord[]
}

export async function readSnapshot(): Promise<Snapshot> {
  const [statements, transactions, imports] = await Promise.all([
    db.statements.toArray(),
    db.transactions.toArray(),
    db.imports.toArray(),
  ])
  return { statements, transactions, imports }
}

export function toExistingSnapshot(snapshot: Snapshot): ExistingSnapshot {
  return { statements: snapshot.statements, transactions: snapshot.transactions, imports: snapshot.imports }
}

/** Persist a batch of ingest results in a single transaction. */
export async function persistImportResults(results: IngestResult[]): Promise<void> {
  await db.transaction('rw', db.statements, db.transactions, db.imports, async () => {
    for (const result of results) {
      await db.imports.put(result.record)
      if (!result.statement) continue
      await db.statements.put(result.statement)
      await db.transactions.bulkPut(result.transactions)
    }
  })
}

/** Persist a legacy-import plan in a single transaction: all rows or none. */
export async function persistLegacyImport(plan: {
  record: ImportRecord
  statements: Statement[]
  inserted: Transaction[]
}): Promise<void> {
  await db.transaction('rw', db.statements, db.transactions, db.imports, async () => {
    await db.imports.put(plan.record)
    await db.statements.bulkPut(plan.statements)
    for (let offset = 0; offset < plan.inserted.length; offset += 2000) {
      await db.transactions.bulkPut(plan.inserted.slice(offset, offset + 2000))
    }
  })
}

export async function updateTransaction(transaction: Transaction): Promise<void> {
  await db.transactions.put(transaction)
}

export async function updateTransactions(transactions: Transaction[]): Promise<void> {
  await db.transactions.bulkPut(transactions)
}

export async function getReviewNotes(): Promise<Record<string, string>> {
  const rows = await db.reviewNotes.toArray()
  return Object.fromEntries(rows.map((row) => [row.transactionId, row.note]))
}

export async function setReviewNote(transactionId: string, note: string): Promise<void> {
  if (!note.trim()) {
    await db.reviewNotes.delete(transactionId)
    return
  }
  await db.reviewNotes.put({ transactionId, note: note.trim(), updatedAt: new Date().toISOString() })
}

export interface BackupPayload {
  format: 'credit-bill-manager-backup' | 'credit-card-data-backup'
  version: 1
  exportedAt: string
  statements: Statement[]
  transactions: Transaction[]
  imports: ImportRecord[]
  settings: unknown
}

/** Lightweight data backup: transactions + statements + import metadata + settings. No raw files. */
export async function exportBackup(): Promise<BackupPayload> {
  return exportDataBackup()
}

/** Preferred name going forward. Writes `credit-card-data.json`. Keeps the payload identical. */
export async function exportDataBackup(): Promise<BackupPayload> {
  const settings = await db.settings.get('app')
  return {
    format: 'credit-card-data-backup',
    version: 1,
    exportedAt: new Date().toISOString(),
    statements: await db.statements.toArray(),
    transactions: await db.transactions.toArray(),
    imports: await db.imports.toArray(),
    settings: settings?.value ?? null,
  }
}

export function validateBackup(value: unknown): value is BackupPayload {
  if (!value || typeof value !== 'object') return false
  const payload = value as Partial<BackupPayload>
  return (
    (payload.format === 'credit-bill-manager-backup' || payload.format === 'credit-card-data-backup') &&
    payload.version === 1 &&
    Array.isArray(payload.statements) &&
    Array.isArray(payload.transactions) &&
    Array.isArray(payload.imports)
  )
}

/** Restore merges by primary key, so restoring twice is harmless. */
export async function importBackup(payload: BackupPayload): Promise<void> {
  await db.transaction('rw', db.statements, db.transactions, db.imports, db.settings, async () => {
    await db.statements.bulkPut(payload.statements)
    await db.transactions.bulkPut(payload.transactions)
    await db.imports.bulkPut(payload.imports)
    if (payload.settings) await db.settings.put({ key: 'app', value: payload.settings })
  })
}

/** Remove only the fictional demo rows so they can be regenerated cleanly. */
export async function clearDemoData(): Promise<void> {
  // NOTE: `isDemo` is a boolean index; `where('isDemo').equals(1)` never
  // matches it (IndexedDB keys are strictly typed), so deletion uses an
  // explicit boolean filter instead of a numeric comparison.
  await db.transaction('rw', [db.statements, db.transactions, db.imports, db.reviewNotes, db.attachments], async () => {
    const demoTransactions = await db.transactions.filter((row) => row.isDemo === true).primaryKeys()
    const demoImports = await db.imports.filter((row) => row.isDemo === true).toArray()
    const realHashes = new Set((await db.imports.filter((row) => row.isDemo !== true).toArray()).map((row) => row.fileHash))
    await db.statements.filter((row) => row.isDemo === true).delete()
    await db.transactions.filter((row) => row.isDemo === true).delete()
    await db.imports.filter((row) => row.isDemo === true).delete()
    await db.reviewNotes.bulkDelete(demoTransactions)
    await db.attachments.bulkDelete(demoImports.map((row) => row.fileHash).filter((hash) => !realHashes.has(hash)))
  })
}

/**
 * Migration cleanup for databases written by older versions that persisted
 * demo rows into the production tables. Removes fictional rows only; real
 * rows, review notes, attachments and backups are untouched.
 */
export async function purgeDemoRows(): Promise<void> {
  await db.transaction('rw', db.statements, db.transactions, db.imports, async () => {
    await db.statements.filter((row) => row.isDemo === true).delete()
    await db.transactions.filter((row) => row.isDemo === true).delete()
    await db.imports.filter((row) => row.isDemo === true).delete()
  })
}

export async function clearAllData(options: { includeDemo: boolean }): Promise<void> {
  if (options.includeDemo) {
    await db.transaction('rw', [db.statements, db.transactions, db.imports, db.reviewNotes, db.attachments], async () => {
      await db.statements.clear()
      await db.transactions.clear()
      await db.imports.clear()
      await db.reviewNotes.clear()
      await db.attachments.clear()
    })
    return
  }
  await db.transaction('rw', [db.statements, db.transactions, db.imports, db.reviewNotes, db.attachments], async () => {
    // Orphaned sensitive records have no reliable demo provenance. Clearing
    // real data removes them, retaining only evidence and notes demonstrably
    // referenced by surviving fictional rows (including shared file hashes).
    const demoIds = new Set(await db.transactions.filter((row) => row.isDemo === true).primaryKeys())
    const demoHashes = new Set((await db.imports.filter((row) => row.isDemo === true).toArray()).map((row) => row.fileHash))
    await db.statements.filter((row) => row.isDemo !== true).delete()
    await db.transactions.filter((row) => row.isDemo !== true).delete()
    await db.imports.filter((row) => row.isDemo !== true).delete()
    await db.reviewNotes.bulkDelete(await db.reviewNotes.filter((row) => !demoIds.has(row.transactionId)).primaryKeys())
    await db.attachments.bulkDelete(await db.attachments.filter((row) => !demoHashes.has(row.fileHash)).primaryKeys())
  })
}

export async function storageEstimate(): Promise<{ usage: number; quota: number } | null> {
  if (!navigator.storage?.estimate) return null
  const estimate = await navigator.storage.estimate()
  return { usage: estimate.usage ?? 0, quota: estimate.quota ?? 0 }
}

// ---------------------------------------------------------------------------
// Original-file lifecycle: indexeddb | external (future) | missing
// ---------------------------------------------------------------------------

export type AttachmentStorage = 'indexeddb' | 'external' | 'missing'

export interface ManifestFileEntry {
  importId: string
  filename: string
  sha256: string
  parserId: string
  importedAt: string
  storage: AttachmentStorage
}

export interface ArchiveManifest {
  version: 1
  createdAt: string
  files: ManifestFileEntry[]
}

export interface ArchiveStatus {
  transactionCount: number
  importCount: number
  archivedCount: number
  missingCount: number
}

export function mimeTypeForFile(fileName: string): string {
  const lower = fileName.toLowerCase()
  if (lower.endsWith('.pdf')) return 'application/pdf'
  if (lower.endsWith('.eml')) return 'message/rfc822'
  if (lower.endsWith('.html') || lower.endsWith('.htm')) return 'text/html'
  if (lower.endsWith('.txt')) return 'text/plain'
  return 'application/octet-stream'
}

/** Store the raw evidence bytes. Idempotent: same hash is never stored twice. */
export async function saveOriginalFile(input: {
  fileHash: string
  fileName: string
  mimeType?: string
  data: ArrayBuffer
  importId: string
  parserId: string
}): Promise<void> {
  const existing = await db.attachments.get(input.fileHash)
  if (existing) return
  const row: AttachmentRow = {
    fileHash: input.fileHash,
    fileName: input.fileName,
    mimeType: input.mimeType ?? mimeTypeForFile(input.fileName),
    size: input.data.byteLength,
    data: input.data.slice(0),
    importId: input.importId,
    parserId: input.parserId,
    importedAt: new Date().toISOString(),
  }
  await db.attachments.put(row)
}

export async function getAttachment(fileHash: string): Promise<AttachmentRow | undefined> {
  return db.attachments.get(fileHash)
}

export async function hasAttachment(fileHash: string): Promise<boolean> {
  return (await db.attachments.get(fileHash)) !== undefined
}

/** Hashes of every stored evidence file. Read-only helper for the data-quality page. */
export async function listAttachmentHashes(): Promise<Set<string>> {
  const rows = await db.attachments.toCollection().primaryKeys()
  return new Set(rows.map(String))
}

/** Build the manifest without inventing files: no row in `attachments` means `missing`. */
export async function buildManifest(): Promise<ArchiveManifest> {
  const imports = await db.imports.toArray()
  const files: ManifestFileEntry[] = []
  for (const record of imports) {
    const attachment = await db.attachments.get(record.fileHash)
    files.push({
      importId: record.id,
      filename: record.fileName,
      sha256: record.fileHash,
      parserId: record.parserId,
      importedAt: record.importedAt,
      storage: attachment ? 'indexeddb' : 'missing',
    })
  }
  files.sort((a, b) => a.importedAt.localeCompare(b.importedAt))
  return { version: 1, createdAt: new Date().toISOString(), files }
}

export function validateManifest(value: unknown): value is ArchiveManifest {
  if (!value || typeof value !== 'object') return false
  const manifest = value as Partial<ArchiveManifest>
  if (manifest.version !== 1 || typeof manifest.createdAt !== 'string' || !Array.isArray(manifest.files)) return false
  return manifest.files.every(
    (entry) =>
      entry &&
      typeof entry === 'object' &&
      typeof entry.importId === 'string' &&
      typeof entry.filename === 'string' &&
      typeof entry.sha256 === 'string' &&
      typeof entry.parserId === 'string' &&
      typeof entry.importedAt === 'string' &&
      (entry.storage === 'indexeddb' || entry.storage === 'external' || entry.storage === 'missing'),
  )
}

/** Count how many imports still have evidence available vs. data-only rows. Real rows only. */
export async function getArchiveStatus(): Promise<ArchiveStatus> {
  const [transactions, imports] = await Promise.all([db.transactions.toArray(), db.imports.toArray()])
  const realTransactions = transactions.filter((row) => !row.isDemo)
  const realImports = imports.filter((row) => !row.isDemo)
  let archivedCount = 0
  for (const record of realImports) {
    if (await db.attachments.get(record.fileHash)) archivedCount += 1
  }
  return {
    transactionCount: realTransactions.length,
    importCount: realImports.length,
    archivedCount,
    missingCount: realImports.length - archivedCount,
  }
}
