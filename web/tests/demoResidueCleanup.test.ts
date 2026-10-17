import { beforeEach, describe, expect, it, vi } from 'vitest'
import { db, type AttachmentRow } from '../src/db/db'
import type { ImportRecord, Statement, Transaction } from '../src/core/types'
import { sha256Hex } from '../src/parsers/extract'
import { buildFullBackupZip, restoreFullBackupZip } from '../src/backup/archive'
import { ingestSynthetic } from './fixtures/identity'
import {
  ensureDemoRowsPurged,
  exportDataBackup,
  importBackup,
  persistImportResults,
  purgeDemoRows,
} from '../src/db/repository'

const DEMO_PURGE_KEY = 'migration:memory-only-demo'
const UPDATED_AT = '2026-01-02T03:04:05.000Z'

type DemoFlag = boolean | undefined

interface SyntheticRows {
  statement: Statement
  transaction: Transaction
  importRecord: ImportRecord
}

function withDemoFlag<T extends { isDemo?: boolean }>(row: T, isDemo: DemoFlag): T {
  const result = { ...row }
  if (isDemo === undefined) delete result.isDemo
  else result.isDemo = isDemo
  return result
}

function syntheticRows(name: string, fileHash: string, isDemo: DemoFlag): SyntheticRows {
  const generated = ingestSynthetic([`消费 合成清理交易 ${name}`], fileHash)
  const statementId = `statement-${name}`
  return {
    statement: withDemoFlag({ ...generated.statement!, id: statementId }, isDemo),
    transaction: withDemoFlag({
      ...generated.transactions[0]!,
      id: `transaction-${name}`,
      statementId,
    }, isDemo),
    importRecord: withDemoFlag({
      ...generated.record,
      id: `import-${name}`,
      fileHash,
    }, isDemo),
  }
}

function syntheticDemoIngestResult(name: string, fileHash: string) {
  const generated = ingestSynthetic([`消费 受控持久化 Demo ${name}`], fileHash)
  const statementId = `statement-controlled-${name}`
  const transactions = generated.transactions.map((row, index) => withDemoFlag({
    ...row,
    id: `transaction-controlled-${name}-${index}`,
    statementId,
  }, true))
  return {
    ...generated,
    statement: withDemoFlag({ ...generated.statement!, id: statementId }, true),
    transactions,
    inserted: transactions,
    record: withDemoFlag({
      ...generated.record,
      id: `import-controlled-${name}`,
      fileHash,
    }, true),
  }
}

function syntheticAttachment(fileHash: string, importId: string, bytes = [1, 2, 3]): AttachmentRow {
  return {
    fileHash,
    fileName: `synthetic-${fileHash}.txt`,
    mimeType: 'text/plain',
    size: bytes.length,
    data: Uint8Array.from(bytes).buffer,
    importId,
    parserId: 'synthetic',
    importedAt: UPDATED_AT,
  }
}

async function seedRows(rows: SyntheticRows[]): Promise<void> {
  await db.statements.bulkPut(rows.map((row) => row.statement))
  await db.transactions.bulkPut(rows.map((row) => row.transaction))
  await db.imports.bulkPut(rows.map((row) => row.importRecord))
}

function byKey<T>(rows: T[], key: (row: T) => string): T[] {
  return [...rows].sort((left, right) => key(left).localeCompare(key(right)))
}

beforeEach(async () => {
  vi.restoreAllMocks()
  await db.delete()
  await db.open()
})

describe('legacy Demo residue cleanup', () => {
  it('deletes only notes and attachments whose surviving Demo parent proves provenance', async () => {
    const demo = syntheticRows('demo-only', 'demo-only-hash', true)
    const real = syntheticRows('real-only', 'real-only-hash', false)
    const sharedDemo = syntheticRows('shared-demo', 'shared-hash', true)
    const sharedReal = syntheticRows('shared-real', 'shared-hash', false)
    const demoImportWithRealHash = syntheticRows('demo-import-real-hash', 'protected-hash', true)
    const realImportProtectingHash = syntheticRows('real-import-protecting-hash', 'protected-hash', false)
    const historical = syntheticRows('historical-no-demo-flag', 'historical-hash', false)
    historical.statement = withDemoFlag(historical.statement, undefined)
    historical.transaction = withDemoFlag(historical.transaction, undefined)
    historical.importRecord = withDemoFlag(historical.importRecord, undefined)

    const rows = [demo, real, sharedDemo, sharedReal, demoImportWithRealHash,
      realImportProtectingHash, historical]
    await seedRows(rows)

    const notes = [
      { transactionId: demo.transaction.id, note: 'synthetic Demo note: remove', updatedAt: UPDATED_AT },
      { transactionId: real.transaction.id, note: 'synthetic real note: retain', updatedAt: UPDATED_AT },
      { transactionId: 'orphan-note-with-no-transaction', note: 'synthetic orphan note: retain', updatedAt: UPDATED_AT },
      { transactionId: historical.transaction.id, note: 'synthetic note with unknown transaction provenance: retain', updatedAt: UPDATED_AT },
    ]
    await db.reviewNotes.bulkPut(notes)

    const orphanSha256 = 'a'.repeat(64)
    const attachments = [
      // File hash is the proven relationship; importId alone is not the classifier.
      syntheticAttachment(demo.importRecord.fileHash, real.importRecord.id, [11, 12, 13]),
      syntheticAttachment(sharedDemo.importRecord.fileHash, sharedDemo.importRecord.id, [21, 22]),
      // importId points at Demo, but a real import protects this same hash.
      syntheticAttachment(demoImportWithRealHash.importRecord.fileHash, demoImportWithRealHash.importRecord.id, [31, 32, 33]),
      syntheticAttachment(real.importRecord.fileHash, real.importRecord.id, [41]),
      syntheticAttachment(historical.importRecord.fileHash, historical.importRecord.id, [51, 52]),
      syntheticAttachment(orphanSha256, 'missing-import-sha256', [61, 62, 63, 64]),
      syntheticAttachment('unavailable-legacy-attachment', 'missing-import-unavailable', [71]),
      syntheticAttachment('demo-legacy-orphan', 'missing-import-demo', [81, 82]),
    ]
    await db.attachments.bulkPut(attachments)

    const preferences = { theme: 'dark', demoMode: false, locale: 'zh-CN', syntheticPreference: 'keep' }
    await db.settings.put({ key: 'app', value: preferences })

    const notesScan = vi.spyOn(db.reviewNotes, 'toArray')
    const attachmentsScan = vi.spyOn(db.attachments, 'toArray')
    await purgeDemoRows()
    expect(notesScan).not.toHaveBeenCalled()
    expect(attachmentsScan).not.toHaveBeenCalled()
    notesScan.mockRestore()
    attachmentsScan.mockRestore()

    expect(await db.statements.toArray()).toEqual(byKey(
      rows.filter((row) => row !== demo && row !== sharedDemo && row !== demoImportWithRealHash)
        .map((row) => row.statement),
      (row) => row.id,
    ))
    expect(await db.transactions.toArray()).toEqual(byKey(
      rows.filter((row) => row !== demo && row !== sharedDemo && row !== demoImportWithRealHash)
        .map((row) => row.transaction),
      (row) => row.id,
    ))
    expect(await db.imports.toArray()).toEqual(byKey(
      rows.filter((row) => row !== demo && row !== sharedDemo && row !== demoImportWithRealHash)
        .map((row) => row.importRecord),
      (row) => row.id,
    ))
    expect(await db.reviewNotes.toArray()).toEqual(byKey(
      [notes[1]!, notes[2]!, notes[3]!],
      (row) => row.transactionId,
    ))
    expect(await db.attachments.toArray()).toEqual(byKey(
      attachments.filter((row) => row.fileHash !== demo.importRecord.fileHash),
      (row) => row.fileHash,
    ))
    expect((await db.settings.get('app'))?.value).toEqual(preferences)
    expect((await db.settings.get(DEMO_PURGE_KEY))?.value).toBe(true)

    const afterFirstPurge = await Promise.all([
      db.statements.toArray(), db.transactions.toArray(), db.imports.toArray(),
      db.reviewNotes.toArray(), db.attachments.toArray(), db.settings.toArray(),
    ])
    await purgeDemoRows()
    expect(await Promise.all([
      db.statements.toArray(), db.transactions.toArray(), db.imports.toArray(),
      db.reviewNotes.toArray(), db.attachments.toArray(), db.settings.toArray(),
    ])).toEqual(afterFirstPurge)
  })

  it('keeps the old marker protocol and skips a scan when marker=true already exists', async () => {
    const demo = syntheticRows('marked-demo', 'marked-demo-hash', true)
    await seedRows([demo])
    await db.reviewNotes.put({ transactionId: demo.transaction.id, note: 'synthetic marked note', updatedAt: UPDATED_AT })
    await db.attachments.put(syntheticAttachment(demo.importRecord.fileHash, demo.importRecord.id))
    await db.settings.put({ key: DEMO_PURGE_KEY, value: true })

    await ensureDemoRowsPurged()

    expect(await db.transactions.get(demo.transaction.id)).toEqual(demo.transaction)
    expect(await db.imports.get(demo.importRecord.id)).toEqual(demo.importRecord)
    expect(await db.reviewNotes.get(demo.transaction.id)).toEqual({
      transactionId: demo.transaction.id, note: 'synthetic marked note', updatedAt: UPDATED_AT,
    })
    expect(await db.attachments.get(demo.importRecord.fileHash)).toEqual(
      syntheticAttachment(demo.importRecord.fileHash, demo.importRecord.id),
    )
  })

  it('runs the full cleanup when the marker is absent and explicit Demo parents exist', async () => {
    const demo = syntheticRows('unmarked-demo', 'unmarked-demo-hash', true)
    const real = syntheticRows('unmarked-real', 'unmarked-real-hash', false)
    await seedRows([demo, real])
    const note = { transactionId: demo.transaction.id, note: 'synthetic removable note', updatedAt: UPDATED_AT }
    await db.reviewNotes.put(note)
    const evidence = syntheticAttachment(demo.importRecord.fileHash, demo.importRecord.id, [7, 8, 9])
    await db.attachments.put(evidence)

    await ensureDemoRowsPurged()

    expect(await db.statements.get(demo.statement.id)).toBeUndefined()
    expect(await db.transactions.get(demo.transaction.id)).toBeUndefined()
    expect(await db.imports.get(demo.importRecord.id)).toBeUndefined()
    expect(await db.reviewNotes.get(demo.transaction.id)).toBeUndefined()
    expect(await db.attachments.get(evidence.fileHash)).toBeUndefined()
    expect(await db.transactions.get(real.transaction.id)).toEqual(real.transaction)
    expect(await db.imports.get(real.importRecord.id)).toEqual(real.importRecord)
    expect((await db.settings.get(DEMO_PURGE_KEY))?.value).toBe(true)
  })

  it('invalidates the marker through the controlled Demo persistence path and cleans again', async () => {
    const preferences = { theme: 'light', demoMode: false, locale: 'zh-CN' }
    await db.settings.put({ key: 'app', value: preferences })
    await db.settings.put({ key: DEMO_PURGE_KEY, value: true })
    const result = syntheticDemoIngestResult('reintroduced', 'controlled-demo-hash')
    await persistImportResults([result])

    expect(await db.settings.get(DEMO_PURGE_KEY)).toBeUndefined()
    const transaction = result.transactions[0]!
    await db.reviewNotes.put({ transactionId: transaction.id, note: 'synthetic controlled Demo note', updatedAt: UPDATED_AT })
    await db.attachments.put(syntheticAttachment(result.record.fileHash, result.record.id, [9, 8, 7]))

    await ensureDemoRowsPurged()

    expect(await db.statements.get(result.statement!.id)).toBeUndefined()
    expect(await db.transactions.get(transaction.id)).toBeUndefined()
    expect(await db.imports.get(result.record.id)).toBeUndefined()
    expect(await db.reviewNotes.get(transaction.id)).toBeUndefined()
    expect(await db.attachments.get(result.record.fileHash)).toBeUndefined()
    expect((await db.settings.get('app'))?.value).toEqual(preferences)
    expect((await db.settings.get(DEMO_PURGE_KEY))?.value).toBe(true)
  })

  it('keeps V2 JSON note restore and ZIP note-plus-attachment restore unchanged', async () => {
    const bytes = new TextEncoder().encode('fixed synthetic backup evidence')
    const fileHash = await sha256Hex(bytes.buffer as ArrayBuffer)
    const generated = ingestSynthetic(['消费 合成备份往返交易'], fileHash)
    const real: SyntheticRows = {
      statement: generated.statement!,
      transaction: generated.transactions[0]!,
      importRecord: generated.record,
    }
    const note = {
      transactionId: real.transaction.id,
      note: 'synthetic backup review note',
      updatedAt: UPDATED_AT,
    }
    const attachment = syntheticAttachment(fileHash, real.importRecord.id, [...bytes])
    await seedRows([real])
    await db.reviewNotes.put(note)
    await db.attachments.put(attachment)

    const jsonPayload = await exportDataBackup()
    const { blob: zipBlob } = await buildFullBackupZip()
    expect(jsonPayload.version).toBe(2)
    expect(jsonPayload.version === 2 ? jsonPayload.reviewNotes : []).toEqual([note])

    await db.delete()
    await db.open()
    await importBackup(jsonPayload)
    expect(await db.reviewNotes.get(note.transactionId)).toEqual(note)
    // JSON backups contain review notes, not raw evidence bytes.
    expect(await db.attachments.get(fileHash)).toBeUndefined()

    await db.delete()
    await db.open()
    const restored = await restoreFullBackupZip(zipBlob)
    expect(restored.notes).toBe(1)
    expect(restored.files).toBe(1)
    expect(await db.reviewNotes.get(note.transactionId)).toEqual(note)
    const restoredAttachment = await db.attachments.get(fileHash)
    expect(restoredAttachment).toMatchObject({
      fileHash,
      fileName: real.importRecord.fileName,
      mimeType: 'text/plain',
      size: bytes.byteLength,
      importId: real.importRecord.id,
      parserId: real.importRecord.parserId,
    })
    expect([...new Uint8Array(restoredAttachment!.data)]).toEqual([...bytes])
  })

  it('rolls back all six stores and preserves the marker when attachment deletion fails', async () => {
    const demo = syntheticRows('rollback-demo', 'rollback-demo-hash', true)
    const real = syntheticRows('rollback-real', 'rollback-real-hash', false)
    await seedRows([demo, real])
    const notes = [
      { transactionId: demo.transaction.id, note: 'synthetic Demo rollback note', updatedAt: UPDATED_AT },
      { transactionId: real.transaction.id, note: 'synthetic real rollback note', updatedAt: UPDATED_AT },
    ]
    const attachments = [
      syntheticAttachment(demo.importRecord.fileHash, demo.importRecord.id, [1, 2, 3, 4]),
      syntheticAttachment(real.importRecord.fileHash, real.importRecord.id, [5, 6, 7]),
    ]
    const preferences = { theme: 'dark', demoMode: false, locale: 'zh-CN', before: 'unchanged' }
    await db.reviewNotes.bulkPut(notes)
    await db.attachments.bulkPut(attachments)
    await db.settings.put({ key: 'app', value: preferences })
    await db.settings.put({ key: DEMO_PURGE_KEY, value: false })

    const fail = vi.spyOn(db.attachments, 'bulkDelete')
      .mockRejectedValueOnce(new Error('synthetic attachment deletion failure'))
    await expect(purgeDemoRows()).rejects.toThrow('synthetic attachment deletion failure')
    fail.mockRestore()

    expect(await db.statements.toArray()).toEqual(byKey(rowsToStatements([demo, real]), (row) => row.id))
    expect(await db.transactions.toArray()).toEqual(byKey([demo.transaction, real.transaction], (row) => row.id))
    expect(await db.imports.toArray()).toEqual(byKey([demo.importRecord, real.importRecord], (row) => row.id))
    expect(await db.reviewNotes.toArray()).toEqual(byKey(notes, (row) => row.transactionId))
    expect(await db.attachments.toArray()).toEqual(byKey(attachments, (row) => row.fileHash))
    expect((await db.settings.get('app'))?.value).toEqual(preferences)
    expect((await db.settings.get(DEMO_PURGE_KEY))?.value).toBe(false)
  })
})

function rowsToStatements(rows: SyntheticRows[]): Statement[] {
  return rows.map((row) => row.statement)
}
