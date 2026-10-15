import JSZip from 'jszip'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from '../src/db/db'
import {
  buildDataBackupBlob,
  exportDataBackup,
  importBackup,
  persistImportResults,
  saveOriginalFile,
  setReviewNote,
  validateBackup,
  type BackupPayload,
} from '../src/db/repository'
import {
  buildFullBackupZip,
  DATABASE_JSON,
  MANIFEST_JSON,
  previewFullBackupZip,
  restoreFullBackupZip,
} from '../src/backup/archive'
import { readJsonBackup } from '../src/backup/json'
import { MAX_NOTE_CHARS } from '../src/backup/validation'
import { buildDemoDataset } from '../src/demo/demoData'
import { sha256Hex } from '../src/parsers/extract'

beforeEach(async () => {
  await db.delete()
  await db.open()
  vi.restoreAllMocks()
})

async function seedLedgerWithNotes(count = 3): Promise<{ ids: string[] }> {
  await persistImportResults(buildDemoDataset())
  const txs = (await db.transactions.toArray()).slice(0, count)
  const ids: string[] = []
  for (const tx of txs) {
    await setReviewNote(tx.id, `note for ${tx.id}`)
    ids.push(tx.id)
  }
  return { ids }
}

function toV1(payload: BackupPayload): BackupPayload {
  const v1 = { ...payload, version: 1 as const } as unknown as Record<string, unknown>
  delete v1.reviewNotes
  return v1 as unknown as BackupPayload
}

describe('V2 JSON export and fresh restore', () => {
  it('round-trips financial records and notes into a fresh database', async () => {
    await seedLedgerWithNotes(5)
    const payload = await exportDataBackup()
    expect(payload.version).toBe(2)
    if (payload.version !== 2) throw new Error('expected V2')
    expect(payload.reviewNotes.length).toBe(5)
    const beforeTx = await db.transactions.toArray()
    const beforeNotes = await db.reviewNotes.toArray()
    await db.delete()
    await db.open()
    await importBackup(payload)
    const afterTx = await db.transactions.toArray()
    const afterNotes = await db.reviewNotes.toArray()
    expect(afterTx.length).toBe(beforeTx.length)
    // Exact financial preservation.
    const byId = new Map(afterTx.map((row) => [row.id, row]))
    for (const row of beforeTx) expect(byId.get(row.id)).toEqual(row)
    // Exact note preservation.
    expect(afterNotes.length).toBe(beforeNotes.length)
    const noteById = new Map(afterNotes.map((row) => [row.transactionId, row]))
    for (const row of beforeNotes) {
      const got = noteById.get(row.transactionId)
      expect(got?.note).toBe(row.note)
      expect(got?.updatedAt).toBe(row.updatedAt)
    }
  })

  it('recovers Unicode, Chinese, punctuation, line breaks and non-ASCII exactly', async () => {
    await persistImportResults(buildDemoDataset())
    const txs = await db.transactions.toArray()
    const samples = [
      '中文备注：与银行App对账一致，确认为退款。',
      'Unicode: café — naïve façade 🎉 “quotes” ‘single’ …',
      'punctuation: ,.;:!?"\'()[]{}<>@#$%^&*-_=+\\/|`~',
      'line\nbreaks\r\nand\ttabs  plus  spaces',
      '混合 Mixed 中文 and emoji ✅ 12345',
    ]
    for (let i = 0; i < samples.length; i++) {
      const id = txs[i]!.id
      await db.reviewNotes.put({ transactionId: id, note: samples[i]!, updatedAt: `2026-03-0${i + 1}T10:00:00.000Z` })
    }
    const payload = await exportDataBackup()
    if (payload.version !== 2) throw new Error('expected V2')
    await db.delete()
    await db.open()
    await importBackup(payload)
    for (let i = 0; i < samples.length; i++) {
      const got = await db.reviewNotes.get(txs[i]!.id)
      expect(got?.note).toBe(samples[i])
      expect(got?.updatedAt).toBe(`2026-03-0${i + 1}T10:00:00.000Z`)
    }
    // Blob round-trip through the bounded JSON path preserves the same bytes.
    const blob = await buildDataBackupBlob()
    const decoded = (await readJsonBackup(blob)) as BackupPayload
    expect(validateBackup(decoded)).toBe(true)
    await db.delete()
    await db.open()
    await importBackup(decoded)
    for (let i = 0; i < samples.length; i++) {
      expect((await db.reviewNotes.get(txs[i]!.id))?.note).toBe(samples[i])
    }
  })

  it('preserves updatedAt and transaction associations', async () => {
    await persistImportResults(buildDemoDataset())
    const tx = (await db.transactions.toArray())[0]!
    const fixed = '2026-02-14T08:30:00.000Z'
    await db.reviewNotes.put({ transactionId: tx.id, note: 'fixed timestamp note', updatedAt: fixed })
    const payload = await exportDataBackup()
    if (payload.version !== 2) throw new Error('expected V2')
    expect(payload.reviewNotes.find((n) => n.transactionId === tx.id)).toMatchObject({ note: 'fixed timestamp note', updatedAt: fixed })
    await db.delete()
    await db.open()
    await importBackup(payload)
    expect(await db.reviewNotes.get(tx.id)).toMatchObject({ note: 'fixed timestamp note', updatedAt: fixed })
  })

  it('is idempotent on repeated restore without duplication or changes', async () => {
    await seedLedgerWithNotes(4)
    const payload = await exportDataBackup()
    await db.delete()
    await db.open()
    await importBackup(payload)
    const firstNotes = await db.reviewNotes.toArray()
    const firstTxCount = await db.transactions.count()
    await importBackup(payload)
    await importBackup(payload)
    expect(await db.transactions.count()).toBe(firstTxCount)
    expect(await db.reviewNotes.toArray()).toEqual(firstNotes)
  })

  it('does not duplicate note content inside transaction records', async () => {
    await seedLedgerWithNotes(2)
    const payload = await exportDataBackup()
    const text = JSON.stringify(payload.transactions)
    const notes = payload.version === 2 ? payload.reviewNotes.map((n) => n.note) : []
    for (const note of notes) {
      if (note.length >= 8) expect(text).not.toContain(note)
    }
  })
})

describe('V2 ZIP export and fresh restore', () => {
  it('round-trips notes plus attachments into a fresh database', async () => {
    await persistImportResults(buildDemoDataset())
    const txs = await db.transactions.toArray()
    await setReviewNote(txs[0]!.id, 'zip note one 中文 🎉')
    await setReviewNote(txs[1]!.id, 'zip note two\nsecond line')
    const record = (await db.imports.toArray())[0]!
    const bytes = new TextEncoder().encode('zip-evidence-bytes')
    const fileHash = await sha256Hex(bytes.buffer)
    await db.imports.put({ ...record, fileHash, isDemo: false })
    await saveOriginalFile({ fileHash, fileName: record.fileName, data: bytes.buffer, importId: record.id, parserId: record.parserId })
    const { blob } = await buildFullBackupZip()
    const preview = await previewFullBackupZip(blob)
    expect(preview.backupVersion).toBe(2)
    expect(preview.reviewNotesCount).toBe(2)
    const beforeTx = await db.transactions.toArray()
    const beforeNotes = await db.reviewNotes.toArray()
    await db.delete()
    await db.open()
    const result = await restoreFullBackupZip(blob)
    expect(result.backupVersion).toBe(2)
    expect(result.notes).toBe(2)
    expect(await db.transactions.count()).toBe(beforeTx.length)
    for (const row of beforeTx) expect(await db.transactions.get(row.id)).toEqual(row)
    for (const row of beforeNotes) expect(await db.reviewNotes.get(row.transactionId)).toEqual(row)
    expect(await db.attachments.get(fileHash)).toBeDefined()
    // Repeat is idempotent.
    const second = await restoreFullBackupZip(blob)
    expect(second.files).toBe(0)
    expect(await db.transactions.count()).toBe(beforeTx.length)
    expect(await db.reviewNotes.toArray()).toEqual(beforeNotes)
  })
})

describe('note conflict handling', () => {
  it('rejects conflicting note content without partial changes', async () => {
    await seedLedgerWithNotes(3)
    const payload = await exportDataBackup()
    if (payload.version !== 2) throw new Error('expected V2')
    const target = payload.reviewNotes[0]!
    await db.reviewNotes.put({ ...target, note: 'local diverging version' })
    const txCount = await db.transactions.count()
    const notesBefore = await db.reviewNotes.toArray()
    await expect(importBackup(payload)).rejects.toThrow('复核备注冲突')
    expect(await db.transactions.count()).toBe(txCount)
    expect(await db.reviewNotes.toArray()).toEqual(notesBefore)
  })

  it('preserves existing rows on identical content even if timestamps differ', async () => {
    await persistImportResults(buildDemoDataset())
    const tx = (await db.transactions.toArray())[0]!
    await db.reviewNotes.put({ transactionId: tx.id, note: 'same content', updatedAt: '2026-01-01T00:00:00.000Z' })
    const payload = await exportDataBackup()
    if (payload.version !== 2) throw new Error('expected V2')
    // Incoming has same content but a newer timestamp.
    const incoming = { ...payload, reviewNotes: [{ transactionId: tx.id, note: 'same content', updatedAt: '2026-06-01T00:00:00.000Z' }] }
    expect(validateBackup(incoming)).toBe(true)
    await importBackup(incoming as BackupPayload)
    // Existing row (including its timestamp) is preserved.
    expect(await db.reviewNotes.get(tx.id)).toMatchObject({ note: 'same content', updatedAt: '2026-01-01T00:00:00.000Z' })
  })

  it('never deletes local notes missing from the payload', async () => {
    await persistImportResults(buildDemoDataset())
    const txs = await db.transactions.toArray()
    await setReviewNote(txs[0]!.id, 'local only note')
    const payload = await exportDataBackup()
    if (payload.version !== 2) throw new Error('expected V2')
    // Simulate an older export without this note.
    const older = { ...payload, reviewNotes: [] }
    await db.reviewNotes.put({ transactionId: txs[1]!.id, note: 'newer local note', updatedAt: new Date().toISOString() })
    await importBackup(older as BackupPayload)
    expect((await db.reviewNotes.get(txs[0]!.id))?.note).toBe('local only note')
    expect((await db.reviewNotes.get(txs[1]!.id))?.note).toBe('newer local note')
  })
})

describe('V1 compatibility', () => {
  it('V1 JSON restore leaves existing notes untouched', async () => {
    await seedLedgerWithNotes(2)
    const v2 = await exportDataBackup()
    const v1 = toV1(v2)
    expect(validateBackup(v1)).toBe(true)
    const txs = await db.transactions.toArray()
    await setReviewNote(txs[0]!.id, 'existing local note')
    const before = await db.reviewNotes.toArray()
    await importBackup(v1)
    expect(await db.reviewNotes.toArray()).toEqual(before)
  })

  it('V1 ZIP restore leaves existing notes untouched', async () => {
    await seedLedgerWithNotes(2)
    const { blob } = await buildFullBackupZip()
    const zip = await JSZip.loadAsync(blob)
    const database = JSON.parse(await zip.file(DATABASE_JSON)!.async('string'))
    const v1 = { ...database, version: 1 }
    delete v1.reviewNotes
    expect(validateBackup(v1)).toBe(true)
    zip.file(DATABASE_JSON, JSON.stringify(v1))
    const v1blob = await zip.generateAsync({ type: 'blob' })
    const txs = await db.transactions.toArray()
    await setReviewNote(txs[0]!.id, 'zip local note')
    const before = await db.reviewNotes.toArray()
    const result = await restoreFullBackupZip(v1blob)
    expect(result.backupVersion).toBe(1)
    expect(await db.reviewNotes.toArray()).toEqual(before)
  })

  it('V1 restore into a fresh profile invents no notes', async () => {
    await seedLedgerWithNotes(3)
    const v1 = toV1(await exportDataBackup())
    await db.delete()
    await db.open()
    await importBackup(v1)
    expect(await db.reviewNotes.count()).toBe(0)
    expect(await db.transactions.count()).toBeGreaterThan(0)
  })

  it('V1 ZIP into a fresh profile invents no notes', async () => {
    await seedLedgerWithNotes(2)
    const { blob } = await buildFullBackupZip()
    const zip = await JSZip.loadAsync(blob)
    const database = JSON.parse(await zip.file(DATABASE_JSON)!.async('string'))
    const v1 = { ...database, version: 1 }
    delete v1.reviewNotes
    zip.file(DATABASE_JSON, JSON.stringify(v1))
    const v1blob = await zip.generateAsync({ type: 'blob' })
    await db.delete()
    await db.open()
    await restoreFullBackupZip(v1blob)
    expect(await db.reviewNotes.count()).toBe(0)
  })
})

describe('V2 validation', () => {
  async function baseV2() {
    await persistImportResults(buildDemoDataset())
    const payload = await exportDataBackup()
    if (payload.version !== 2) throw new Error('expected V2')
    return payload
  }

  it('rejects malformed notes, duplicates, bad timestamps/types and versions', async () => {
    const good = await baseV2()
    const txId = good.transactions[0]!.id
    const cases: Array<[string, (p: typeof good) => void]> = [
      ['missing reviewNotes', (p) => { delete (p as unknown as Record<string, unknown>).reviewNotes }],
      ['reviewNotes not array', (p) => { (p as unknown as Record<string, unknown>).reviewNotes = {} }],
      ['duplicate transactionId', (p) => { p.reviewNotes = [{ transactionId: txId, note: 'a', updatedAt: new Date().toISOString() }, { transactionId: txId, note: 'b', updatedAt: new Date().toISOString() }] }],
      ['empty note', (p) => { p.reviewNotes = [{ transactionId: txId, note: '', updatedAt: new Date().toISOString() }] }],
      ['whitespace note', (p) => { p.reviewNotes = [{ transactionId: txId, note: '   ', updatedAt: new Date().toISOString() }] }],
      ['non-string note', (p) => { p.reviewNotes = [{ transactionId: txId, note: 123, updatedAt: new Date().toISOString() } as unknown as typeof p.reviewNotes[number]] }],
      ['oversized note', (p) => { p.reviewNotes = [{ transactionId: txId, note: 'x'.repeat(MAX_NOTE_CHARS + 1), updatedAt: new Date().toISOString() }] }],
      ['bad timestamp', (p) => { p.reviewNotes = [{ transactionId: txId, note: 'ok', updatedAt: 'not-a-date' }] }],
      ['bad transactionId', (p) => { p.reviewNotes = [{ transactionId: '', note: 'ok', updatedAt: new Date().toISOString() }] }],
      ['whitespace transactionId', (p) => { p.reviewNotes = [{ transactionId: 'a b', note: 'ok', updatedAt: new Date().toISOString() }] }],
      ['unsupported version', (p) => { (p as unknown as Record<string, unknown>).version = 3 }],
      ['version as string', (p) => { (p as unknown as Record<string, unknown>).version = '2' }],
      ['notes on V1', (p) => { (p as unknown as Record<string, unknown>).version = 1 }],
    ]
    for (const [name, corrupt] of cases) {
      const candidate = structuredClone(good) as typeof good
      corrupt(candidate)
      expect(validateBackup(candidate), name).toBe(false)
      const count = await db.transactions.count()
      await expect(importBackup(candidate as BackupPayload), name).rejects.toThrow()
      expect(await db.transactions.count(), name).toBe(count)
    }
    // V1 carrying reviewNotes is malformed.
    const v1withNotes = { ...toV1(good), reviewNotes: [] } as unknown
    expect(validateBackup(v1withNotes)).toBe(false)
  })

  it('rejects conflicting financial fields even when notes are present', async () => {
    const payload = await baseV2()
    const bad = structuredClone(payload)
    if (bad.version !== 2) throw new Error('expected V2')
    bad.transactions[0] = { ...bad.transactions[0]!, settlementAmountMinor: bad.transactions[0]!.settlementAmountMinor + 1 }
    await expect(importBackup(bad)).rejects.toThrow('冲突')
  })
})

describe('atomicity and failure injection', () => {
  it('rolls back financial rows when note writes fail', async () => {
    await seedLedgerWithNotes(2)
    const payload = await exportDataBackup()
    await db.delete()
    await db.open()
    const fail = vi.spyOn(db.reviewNotes, 'bulkAdd').mockRejectedValueOnce(new Error('synthetic note quota'))
    await expect(importBackup(payload)).rejects.toThrow('synthetic note quota')
    fail.mockRestore()
    expect(await db.transactions.count()).toBe(0)
    expect(await db.statements.count()).toBe(0)
    expect(await db.imports.count()).toBe(0)
    expect(await db.reviewNotes.count()).toBe(0)
  })

  it('rolls back notes when transaction writes fail late', async () => {
    await seedLedgerWithNotes(3)
    const payload = await exportDataBackup()
    await db.delete()
    await db.open()
    const fail = vi.spyOn(db.transactions, 'bulkAdd').mockRejectedValueOnce(new Error('synthetic late failure'))
    await expect(importBackup(payload)).rejects.toThrow('synthetic late failure')
    fail.mockRestore()
    expect(await db.transactions.count()).toBe(0)
    expect(await db.reviewNotes.count()).toBe(0)
  })

  it('rolls back everything when a later note batch fails', async () => {
    await persistImportResults(buildDemoDataset())
    const txs = await db.transactions.toArray()
    // Enough notes to span multiple 2000-row batches (uses orphans so the
    // payload exercises multi-batch note writes without needing 2000 real rows).
    for (const tx of txs.slice(0, 10)) {
      await db.reviewNotes.put({ transactionId: tx.id, note: `batch note ${tx.id}`, updatedAt: new Date().toISOString() })
    }
    for (let i = 0; i < 2500; i++) {
      await db.reviewNotes.put({ transactionId: `orphan-batch-${i}`, note: `orphan batch note ${i}`, updatedAt: new Date().toISOString() })
    }
    const payload = await exportDataBackup()
    if (payload.version !== 2) throw new Error('expected V2')
    expect(payload.reviewNotes.length).toBeGreaterThan(2000)
    await db.delete()
    await db.open()
    let calls = 0
    const fail = vi.spyOn(db.reviewNotes, 'bulkAdd').mockImplementation(((items: never, ...rest: never[]) => {
      calls += 1
      if (calls === 2) throw new Error('synthetic late batch failure')
      return (db.reviewNotes.bulkAdd as (...callArgs: never[]) => Promise<string>)(items, ...rest)
    }) as typeof db.reviewNotes.bulkAdd)
    await expect(importBackup(payload)).rejects.toThrow('synthetic late batch failure')
    fail.mockRestore()
    expect(await db.transactions.count()).toBe(0)
    expect(await db.reviewNotes.count()).toBe(0)
  })

  it('ZIP tampering rolls back notes as well as financial rows', async () => {
    await persistImportResults(buildDemoDataset())
    const txs = await db.transactions.toArray()
    await setReviewNote(txs[0]!.id, 'zip atomic note')
    const record = (await db.imports.toArray())[0]!
    const bytes = new TextEncoder().encode('atomic-evidence')
    const fileHash = await sha256Hex(bytes.buffer)
    await db.imports.put({ ...record, fileHash, isDemo: false })
    await saveOriginalFile({ fileHash, fileName: record.fileName, data: bytes.buffer, importId: record.id, parserId: record.parserId })
    const { blob } = await buildFullBackupZip()
    const zip = await JSZip.loadAsync(blob)
    const names = Object.keys(zip.files).filter((p) => p.startsWith('original-files/') && !zip.files[p]!.dir)
    zip.file(names[0]!, 'tampered bytes')
    const tampered = await zip.generateAsync({ type: 'blob' })
    await db.delete()
    await db.open()
    await expect(restoreFullBackupZip(tampered)).rejects.toThrow(/SHA-256/)
    expect(await db.transactions.count()).toBe(0)
    expect(await db.reviewNotes.count()).toBe(0)
  })
})

describe('orphaned notes', () => {
  it('exports and restores orphans without dropping recoverable text', async () => {
    await persistImportResults(buildDemoDataset())
    const tx = (await db.transactions.toArray())[0]!
    await setReviewNote(tx.id, 'attached note')
    const orphanId = 'orphan-transaction-0001'
    const orphan = { transactionId: orphanId, note: '孤儿备注 orphan — must survive 中文 🎉\nsecond line', updatedAt: '2026-04-01T12:00:00.000Z' }
    await db.reviewNotes.put(orphan)
    const payload = await exportDataBackup()
    if (payload.version !== 2) throw new Error('expected V2')
    // Export never silently omits the orphan and never assumes demo ownership.
    expect(payload.reviewNotes.some((n) => n.transactionId === orphanId)).toBe(true)
    expect(validateBackup(payload)).toBe(true)
    await db.delete()
    await db.open()
    await importBackup(payload)
    expect(await db.reviewNotes.get(orphanId)).toEqual(orphan)
    expect((await db.reviewNotes.get(tx.id))?.note).toBe('attached note')
  })
})

describe('snapshot consistency and preview', () => {
  it('exports notes and ledger rows from one consistent snapshot', async () => {
    await persistImportResults(buildDemoDataset())
    const txs = await db.transactions.toArray()
    for (const tx of txs.slice(0, 20)) await db.reviewNotes.put({ transactionId: tx.id, note: `snapshot ${tx.id}`, updatedAt: '2026-05-01T00:00:00.000Z' })
    const stored = await db.reviewNotes.toArray()
    const payload = await exportDataBackup()
    if (payload.version !== 2) throw new Error('expected V2')
    // No missing, no extra, stable sorted order.
    expect(payload.reviewNotes.length).toBe(stored.length)
    expect(payload.reviewNotes.map((n) => n.transactionId)).toEqual([...stored].sort((a, b) => a.transactionId.localeCompare(b.transactionId)).map((n) => n.transactionId))
    const again = await exportDataBackup()
    if (again.version !== 2 || payload.version !== 2) throw new Error('expected V2')
    expect(again.statements).toEqual(payload.statements)
    expect(again.transactions).toEqual(payload.transactions)
    expect(again.imports).toEqual(payload.imports)
    expect(again.reviewNotes).toEqual(payload.reviewNotes)
    expect(again.settings).toEqual(payload.settings)
  })

  it('ZIP preview reports V2 notes and attachment gaps accurately', async () => {
    await seedLedgerWithNotes(2)
    const { blob } = await buildFullBackupZip()
    const preview = await previewFullBackupZip(blob)
    expect(preview.backupVersion).toBe(2)
    expect(preview.reviewNotesCount).toBe(2)
    expect(preview.database.version).toBe(2)
    // V1 archives stay readable and report zero notes.
    const zip = await JSZip.loadAsync(blob)
    const database = JSON.parse(await zip.file(DATABASE_JSON)!.async('string'))
    const manifest = JSON.parse(await zip.file(MANIFEST_JSON)!.async('string'))
    expect(manifest.version).toBe(1)
    const v1 = { ...database, version: 1 }
    delete v1.reviewNotes
    zip.file(DATABASE_JSON, JSON.stringify(v1))
    const v1preview = await previewFullBackupZip(await zip.generateAsync({ type: 'blob' }))
    expect(v1preview.backupVersion).toBe(1)
    expect(v1preview.reviewNotesCount).toBe(0)
  })
})
