import JSZip from 'jszip'
import { beforeEach, expect, it, vi } from 'vitest'
import { db } from '../src/db/db'
import { buildDataBackupBlob, exportDataBackup, importBackup, persistImportResults, setReviewNote } from '../src/db/repository'
import { createJsonBlob, MAX_JSON_CONTAINERS, MAX_JSON_DEPTH, MAX_JSON_TOKENS, parseJsonBytes, readJsonBackup } from '../src/backup/json'
import { MAX_JSON_BYTES, validateZipDirectory } from '../src/backup/zipSafety'
import { buildDemoDataset } from '../src/demo/demoData'
import { buildFullBackupZip, restoreFullBackupZip } from '../src/backup/archive'

beforeEach(async () => { await db.delete(); await db.open(); vi.restoreAllMocks() })
const decode = (text: string) => parseJsonBytes(new TextEncoder().encode(text).buffer)

it('encodes exactly the same v2 values and all audit fields in compact bounded chunks', async () => {
  await persistImportResults(buildDemoDataset())
  const payload = await exportDataBackup()
  const blob = createJsonBlob(payload)
  expect(await readJsonBackup(blob)).toEqual(payload)
  expect(blob.size).toBe(new TextEncoder().encode(JSON.stringify(payload)).length)
  expect(() => createJsonBlob(payload, 32)).toThrow('过大')
  expect(await readJsonBackup(await buildDataBackupBlob())).toMatchObject({ version: 2, transactions: payload.transactions })
})

it('accepts old pretty JSON, old format name and partial settings', async () => {
  await persistImportResults(buildDemoDataset())
  const payload = { ...await exportDataBackup(), format: 'credit-bill-manager-backup', settings: { theme: 'dark' } }
  const decoded = decode(JSON.stringify(payload, null, 2))
  await db.delete(); await db.open()
  await importBackup(decoded as Awaited<ReturnType<typeof exportDataBackup>>)
  expect(await db.transactions.count()).toBe(payload.transactions.length)
  expect((await db.settings.get('app'))?.value).toEqual({ theme: 'dark' })
})

it('rejects byte limits before reading, invalid UTF-8, deep JSON and unterminated strings', async () => {
  const blob = new Blob(['{}'])
  vi.spyOn(blob, 'size', 'get').mockReturnValue(MAX_JSON_BYTES + 1)
  await expect(readJsonBackup(blob)).rejects.toThrow('过大')
  expect(() => parseJsonBytes(new Uint8Array([0xff]).buffer)).toThrow()
  expect(() => decode('['.repeat(MAX_JSON_DEPTH + 1) + ']'.repeat(MAX_JSON_DEPTH + 1))).toThrow('嵌套')
  expect(() => decode('{"x":"unfinished')).toThrow()
  expect(() => decode('{broken}')).toThrow()
  const escaped = { escaped: '"{}[]\\', nested: [1, true, null] }
  expect(decode(JSON.stringify(escaped))).toEqual(escaped)
})

it('rejects tiny-container and scalar bombs before JSON.parse allocates their object graphs', () => {
  expect(() => decode(`[${'[],'.repeat(MAX_JSON_CONTAINERS)}[]]`)).toThrow('结构过大')
  expect(() => decode(`[${'0,'.repeat(MAX_JSON_TOKENS)}0]`)).toThrow('结构过大')
})

it('keeps full fresh-restore statement decisions and existing edits, notes and identity', async () => {
  await persistImportResults(buildDemoDataset())
  const payload = await exportDataBackup()
  await db.delete(); await db.open()
  await importBackup(payload)
  expect(await db.statements.toArray()).toEqual([...payload.statements].sort((a, b) => a.id.localeCompare(b.id)))
  const row = payload.transactions[0]!
  await db.transactions.put({ ...row, category: '旅行', reviewStatus: 'confirmed' })
  await setReviewNote(row.id, 'synthetic retained note')
  await importBackup(payload)
  expect(await db.transactions.get(row.id)).toMatchObject({ category: '旅行', reviewStatus: 'confirmed', fingerprint: row.fingerprint, occurrence: row.occurrence })
  expect((await db.reviewNotes.get(row.id))?.note).toBe('synthetic retained note')
  payload.transactions[0] = { ...row, fingerprint: 'conflicting-identity' }
  await expect(importBackup(payload)).rejects.toThrow('冲突')
  expect(await db.transactions.count()).toBe(payload.transactions.length)
})

it('keeps the old v1 ZIP contract and accepts an ordinary legacy STORE archive', async () => {
  await persistImportResults(buildDemoDataset())
  const { blob } = await buildFullBackupZip()
  const bytes = await import('../src/backup/zipSafety').then(({ readArchiveBytes }) => readArchiveBytes(blob))
  expect(() => validateZipDirectory(bytes)).not.toThrow()
  const zip = await JSZip.loadAsync(bytes)
  const old = new JSZip()
  for (const [name, entry] of Object.entries(zip.files)) if (!entry.dir) old.file(name, await entry.async('uint8array'))
  const legacy = await old.generateAsync({ type: 'blob', compression: 'STORE' })
  const count = await db.transactions.count()
  await db.delete(); await db.open()
  await restoreFullBackupZip(legacy)
  expect(await db.transactions.count()).toBe(count)
})
