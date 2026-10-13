import JSZip from 'jszip'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { db, DEFAULT_SETTINGS } from '../src/db/db'
import { buildDemoDataset } from '../src/demo/demoData'
import { exportDataBackup, importBackup, saveOriginalFile, validateBackup } from '../src/db/repository'
import { buildFullBackupZip, DATABASE_JSON, MANIFEST_JSON, previewFullBackupZip, restoreFullBackupZip } from '../src/backup/archive'
import { sha256Hex } from '../src/parsers/extract'
import { MAX_ARCHIVE_BYTES, MAX_ENTRY_BYTES, readZipEntry, validateZipDirectory } from '../src/backup/zipSafety'

beforeEach(async () => { await db.delete(); await db.open(); vi.restoreAllMocks() })
async function payload() {
  const result = buildDemoDataset()[0]!
  await db.statements.put(result.statement!)
  await db.transactions.bulkPut(result.transactions)
  await db.imports.put(result.record)
  await db.settings.put({ key: 'app', value: DEFAULT_SETTINGS })
  return exportDataBackup()
}

describe('record validation', () => {
  it.each([
    ['fractional minor amount', (p: Awaited<ReturnType<typeof payload>>) => { p.transactions[0]!.settlementAmountMinor = 1.5 }],
    ['non-finite amount', (p: Awaited<ReturnType<typeof payload>>) => { p.transactions[0]!.transactionAmountMinor = Infinity }],
    ['unsafe amount', (p: Awaited<ReturnType<typeof payload>>) => { p.transactions[0]!.settlementAmountMinor = Number.MAX_SAFE_INTEGER + 1 }],
    ['invalid enum', (p: Awaited<ReturnType<typeof payload>>) => { p.transactions[0]!.type = 'invalid' as never }],
    ['empty identifier', (p: Awaited<ReturnType<typeof payload>>) => { p.transactions[0]!.id = '' }],
    ['missing statement', (p: Awaited<ReturnType<typeof payload>>) => { p.transactions[0]!.statementId = 'absent' }],
    ['duplicate record', (p: Awaited<ReturnType<typeof payload>>) => { p.transactions.push(p.transactions[0]!) }],
    ['bad settings', (p: Awaited<ReturnType<typeof payload>>) => { p.settings = { theme: 'invalid' } }],
    ['bad summary', (p: Awaited<ReturnType<typeof payload>>) => { p.statements[0]!.summary.newDebitMinor = NaN }],
    ['invalid date', (p: Awaited<ReturnType<typeof payload>>) => { p.transactions[0]!.postingDate = '2026-02-30' }],
    ['invalid import', (p: Awaited<ReturnType<typeof payload>>) => { p.imports[0]!.fileSize = -1 }],
    ['null record', (p: Awaited<ReturnType<typeof payload>>) => { p.statements.push(null as never) }],
  ])('rejects %s before persistence', async (_name, corrupt) => {
    const p = await payload()
    corrupt(p)
    expect(validateBackup(p)).toBe(false)
    await db.transactions.clear()
    await expect(importBackup(p)).rejects.toThrow()
    expect(await db.transactions.count()).toBe(0)
  })

  it('preserves current user metadata when restoring matching primary keys', async () => {
    const p = await payload()
    const edited = { ...p.transactions[0]!, category: '旅行' as const, reviewStatus: 'confirmed' as const, flags: [] }
    await db.transactions.put(edited)
    await importBackup(p)
    expect(await db.transactions.get(edited.id)).toEqual(edited)
  })

  it('rejects conflicting financial records instead of overwriting a shared primary key', async () => {
    const p = await payload()
    p.transactions[0]!.settlementAmountMinor += 1
    await expect(importBackup(p)).rejects.toThrow()
    expect((await db.transactions.get(p.transactions[0]!.id))!.settlementAmountMinor).not.toBe(p.transactions[0]!.settlementAmountMinor)
  })
})

describe('restore counts', () => {
  it('recomputes derived statement counts when restoring additional transactions', async () => {
    const p = await payload()
    const extra = { ...p.transactions[0]!, id: `${p.transactions[0]!.id}#99`, occurrence: 99 }
    p.transactions.push(extra)
    await importBackup(p)
    expect((await db.statements.get(extra.statementId))!.transactionCount).toBe(p.transactions.length)
  })
})

async function fullArchive() {
  await payload()
  const bytes = new TextEncoder().encode('synthetic evidence')
  const hash = await sha256Hex(bytes.buffer)
  const record = (await db.imports.toArray())[0]!
  await db.imports.put({ ...record, fileHash: hash, isDemo: false })
  await saveOriginalFile({ fileHash: hash, fileName: record.fileName, importId: record.id, parserId: record.parserId, data: bytes.buffer })
  return (await buildFullBackupZip()).blob
}

describe('full restore safety', () => {
  it('rolls back data and settings when storing attachments fails', async () => {
    const blob = await fullArchive()
    await db.delete(); await db.open()
    const fail = vi.spyOn(db.attachments, 'put').mockRejectedValueOnce(new DOMException('quota', 'QuotaExceededError'))
    await expect(restoreFullBackupZip(blob)).rejects.toThrow()
    fail.mockRestore()
    expect(await db.transactions.count()).toBe(0)
    expect(await db.statements.count()).toBe(0)
    expect(await db.imports.count()).toBe(0)
    expect(await db.settings.count()).toBe(0)
    expect(await db.attachments.count()).toBe(0)
  })

  it('rejects a manifest referencing a different import hash before persistence', async () => {
    const zip = await JSZip.loadAsync(await fullArchive())
    const manifest = JSON.parse(await zip.file(MANIFEST_JSON)!.async('string'))
    manifest.files[0].importId = 'unknown-import'
    zip.file(MANIFEST_JSON, JSON.stringify(manifest))
    const corrupt = await zip.generateAsync({ type: 'blob' })
    await db.delete(); await db.open()
    await expect(previewFullBackupZip(corrupt)).rejects.toThrow()
    await expect(restoreFullBackupZip(corrupt)).rejects.toThrow()
    expect(await db.transactions.count()).toBe(0)
  })

  it('rejects missing evidence during preview as well as restore', async () => {
    const zip = await JSZip.loadAsync(await fullArchive())
    for (const path of Object.keys(zip.files)) if (path.startsWith('original-files/')) zip.remove(path)
    const corrupt = await zip.generateAsync({ type: 'blob' })
    await expect(previewFullBackupZip(corrupt)).rejects.toThrow()
  })

  it('rejects corrupt JSON and malformed ZIP without changing persistent data', async () => {
    const zip = await JSZip.loadAsync(await fullArchive())
    zip.file(DATABASE_JSON, '{broken')
    const corrupt = await zip.generateAsync({ type: 'blob' })
    const count = await db.transactions.count()
    await expect(restoreFullBackupZip(corrupt)).rejects.toThrow()
    await expect(restoreFullBackupZip(new Blob(['not a zip']))).rejects.toThrow()
    expect(await db.transactions.count()).toBe(count)
  })

  it('rejects oversized archives before reading them', async () => {
    const blob = new Blob(['small'])
    vi.spyOn(blob, 'size', 'get').mockReturnValue(MAX_ARCHIVE_BYTES + 1)
    await expect(restoreFullBackupZip(blob)).rejects.toThrow('过大')
  })

  it('bounds actual decompression even if declared sizes are misleading', async () => {
    const zip = await JSZip.loadAsync(await new JSZip().file('large', 'x'.repeat(1024)).generateAsync({ type: 'uint8array', compression: 'DEFLATE' }))
    await expect(readZipEntry(zip.file('large')!, 16, { remaining: MAX_ENTRY_BYTES })).rejects.toThrow('过大')
  })

  it('rejects duplicate ZIP paths before JSZip can collapse entries', async () => {
    const data = await new JSZip().file('one', 'a').file('two', 'b').generateAsync({ type: 'arraybuffer' })
    const bytes = new Uint8Array(data)
    const view = new DataView(data)
    for (let offset = 0; offset + 49 <= bytes.length; offset++) {
      if (view.getUint32(offset, true) === 0x02014b50 && new TextDecoder().decode(bytes.slice(offset + 46, offset + 49)) === 'two') {
        bytes.set(new TextEncoder().encode('one'), offset + 46)
        break
      }
    }
    expect(() => validateZipDirectory(data)).toThrow('重复')
  })
})
