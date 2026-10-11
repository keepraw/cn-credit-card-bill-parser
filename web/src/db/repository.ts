import type { ExistingSnapshot, IngestResult } from '../core/ingest'
import type { ImportRecord, Statement, Transaction } from '../core/types'
import { db } from './db'

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
  format: 'credit-bill-manager-backup'
  version: 1
  exportedAt: string
  statements: Statement[]
  transactions: Transaction[]
  imports: ImportRecord[]
  settings: unknown
}

/** Full local backup. The user stores it themselves; nothing is uploaded. */
export async function exportBackup(): Promise<BackupPayload> {
  const settings = await db.settings.get('app')
  return {
    format: 'credit-bill-manager-backup',
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
    payload.format === 'credit-bill-manager-backup' &&
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
  await db.transaction('rw', db.statements, db.transactions, db.imports, db.reviewNotes, async () => {
    await db.statements.where('isDemo').equals(1).delete()
    await db.transactions.where('isDemo').equals(1).delete()
    await db.imports.where('isDemo').equals(1).delete()
    const notes = await db.reviewNotes.toArray()
    await db.reviewNotes.bulkDelete(notes.map((row) => row.transactionId))
  })
}

export async function clearAllData(options: { includeDemo: boolean }): Promise<void> {
  if (options.includeDemo) {
    await db.transaction('rw', db.statements, db.transactions, db.imports, db.reviewNotes, async () => {
      await db.statements.clear()
      await db.transactions.clear()
      await db.imports.clear()
      await db.reviewNotes.clear()
    })
    return
  }
  await db.transaction('rw', db.statements, db.transactions, db.imports, async () => {
    await db.statements.where('isDemo').equals(0).delete()
    await db.transactions.where('isDemo').equals(0).delete()
    await db.imports.where('isDemo').equals(0).delete()
  })
}

export async function storageEstimate(): Promise<{ usage: number; quota: number } | null> {
  if (!navigator.storage?.estimate) return null
  const estimate = await navigator.storage.estimate()
  return { usage: estimate.usage ?? 0, quota: estimate.quota ?? 0 }
}