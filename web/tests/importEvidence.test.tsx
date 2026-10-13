import { act, cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AppProvider, useApp } from '../src/app/AppStore'
import { db, DEFAULT_SETTINGS } from '../src/db/db'
import { sha256Hex } from '../src/parsers/extract'
import { SYNTHETIC_CCB_HTML } from './fixtures/ccbEml'
import { failedImportRecord } from '../src/core/ingest'
import * as registry from '../src/parsers/registry'

let app: ReturnType<typeof useApp>
function Probe() { app = useApp(); return null }
const bytes = (text: string) => new TextEncoder().encode(text).buffer
function file(name: string, read: () => Promise<ArrayBuffer>): File {
  return { name, size: 1, type: 'text/html', arrayBuffer: read } as File
}

beforeEach(async () => {
  await db.delete(); await db.open()
  await db.settings.put({ key: 'app', value: DEFAULT_SETTINGS })
  // Prevent first-visit demo mode without introducing financial records.
  await db.imports.put(failedImportRecord({ fileName: 'synthetic', fileHash: 'seed', fileSize: 1, sourceType: 'text' }, 'seed'))
  render(<AppProvider><Probe /></AppProvider>)
  await waitFor(() => expect(app.state.ready).toBe(true))
  await db.imports.delete('seed:failed')
})
afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('batch original-file association', () => {
  it('does not attach another file after an unreadable file and preserves valid imports', async () => {
    const good = bytes(SYNTHETIC_CCB_HTML)
    const other = bytes('unsupported synthetic file')
    const bad = file('unreadable.html', vi.fn().mockRejectedValue(new Error('read failed')))
    let records: Awaited<ReturnType<typeof app.importFiles>> = []
    await act(async () => { records = await app.importFiles([bad, file('valid.html', async () => good), file('unknown.html', async () => other)]) })
    const hash = await sha256Hex(good)
    const attachment = await db.attachments.get(hash)
    expect(attachment!.fileName).toBe('valid.html')
    expect(new Uint8Array(attachment!.data)).toEqual(new Uint8Array(good))
    expect(await sha256Hex(attachment!.data)).toBe(attachment!.fileHash)
    expect(await db.attachments.get(records[0]!.fileHash)).toBeUndefined()
    expect((await db.attachments.get(await sha256Hex(other)))!.fileName).toBe('unknown.html')
    expect(records.map((record) => record.status)).toEqual(['failed', 'parsed', 'unsupported'])
    expect(await db.transactions.count()).toBeGreaterThan(0)
  })

  it('retries an initial read failure using one buffer for both hashing and evidence', async () => {
    const good = bytes(SYNTHETIC_CCB_HTML)
    const read = vi.fn().mockRejectedValueOnce(new Error('transient')).mockResolvedValue(good)
    await act(async () => { await app.importFiles([file('retry.html', read)]) })
    expect(read).toHaveBeenCalledTimes(2)
    const record = (await db.imports.toArray())[0]!
    expect(record.status).toBe('parsed')
    expect((await db.attachments.get(record.fileHash))!.data).toEqual(good)
  })

  it('retains the bytes already read when document extraction fails without rereading', async () => {
    const invalid = bytes('%PDF-synthetic-invalid')
    const expected = invalid.slice(0)
    const hash = await sha256Hex(expected)
    const read = vi.fn().mockResolvedValueOnce(invalid).mockRejectedValue(new Error('cannot reread'))
    await act(async () => { await app.importFiles([file('invalid.pdf', read)]) })
    const record = (await db.imports.toArray())[0]!
    expect(record.status).toBe('failed')
    expect(read).toHaveBeenCalledTimes(1)
    expect((await db.attachments.get(hash))!.data).toEqual(expected)
  })

  it('binds parser failures to their own evidence and continues the batch', async () => {
    const failed = bytes(SYNTHETIC_CCB_HTML)
    const successful = bytes(`${SYNTHETIC_CCB_HTML}\n`)
    vi.spyOn(registry, 'parseDocument').mockImplementationOnce(() => { throw new Error('controlled parser failure') })
    await act(async () => { await app.importFiles([file('failed.html', async () => failed), file('valid.html', async () => successful)]) })
    expect((await db.attachments.get(await sha256Hex(failed)))!.fileName).toBe('failed.html')
    expect((await db.attachments.get(await sha256Hex(successful)))!.fileName).toBe('valid.html')
    expect((await db.imports.toArray()).map((record) => record.status).sort()).toEqual(['failed', 'parsed'])
  })

  it('keeps distinct records for multiple files whose initial and retry reads fail', async () => {
    await act(async () => { await app.importFiles([
      file('one.html', async () => { throw new Error('unreadable') }),
      file('two.html', async () => { throw new Error('unreadable') }),
    ]) })
    expect(await db.imports.count()).toBe(2)
    expect(await db.attachments.count()).toBe(0)
  })

  it('leaves evidence marked missing on quota failure while keeping parsed transactions', async () => {
    const fail = vi.spyOn(db.attachments, 'put').mockRejectedValueOnce(new DOMException('quota', 'QuotaExceededError'))
    let records: Awaited<ReturnType<typeof app.importFiles>> = []
    await act(async () => { records = await app.importFiles([file('valid.html', async () => bytes(SYNTHETIC_CCB_HTML))]) })
    fail.mockRestore()
    expect(records[0]!.status).toBe('parsed')
    expect(records[0]!.message).toContain('原始文件未保留')
    expect(await db.transactions.count()).toBeGreaterThan(0)
    expect(await db.attachments.count()).toBe(0)
    expect((await app.archiveStatus()).missingCount).toBe(1)
  })
})
