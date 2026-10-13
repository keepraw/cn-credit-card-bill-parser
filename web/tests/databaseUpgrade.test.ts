import Dexie from 'dexie'
import { expect, it } from 'vitest'
import { BillDatabase } from '../src/db/db'
import { ingestSynthetic } from './fixtures/identity'

it('opens a v1 database as v2 without rewriting IDs, financial fields, edits or separate notes', async () => {
  const name = 'synthetic-retirement-upgrade'
  await Dexie.delete(name)
  const old = new Dexie(name)
  old.version(1).stores({
    statements: 'id, bank, cardLast4, cycleEnd, status, isDemo',
    transactions: 'id, statementId, bank, transactionDate, postingDate, type, category, reviewStatus, isDemo, fingerprint, [bank+transactionDate]',
    imports: 'id, fileHash, importedAt, status, isDemo', settings: 'key', reviewNotes: 'transactionId',
  })
  const result = ingestSynthetic(['消费 合成升级商户', '消费 合成升级商户'])
  const rows = result.transactions.map((row) => ({ ...row, category: '旅行', reviewStatus: 'confirmed' }))
  const note = { transactionId: rows[0]!.id, note: 'Synthetic retained note', updatedAt: '2024-01-01T00:00:00Z' }
  await old.open()
  await old.table('statements').add(result.statement)
  await old.table('transactions').bulkAdd(rows)
  await old.table('imports').add(result.record)
  await old.table('settings').add({ key: 'app', value: { demoMode: false } })
  await old.table('reviewNotes').add(note)
  old.close()
  const current = new BillDatabase(name)
  try {
    await current.open()
    expect(current.verno).toBe(2)
    expect(await current.transactions.toArray()).toEqual(rows)
    expect(await current.statements.get(result.statement!.id)).toEqual(result.statement)
    expect(await current.imports.get(result.record.id)).toEqual(result.record)
    expect(await current.reviewNotes.get(note.transactionId)).toEqual(note)
    expect(await current.settings.get('app')).toEqual({ key: 'app', value: { demoMode: false } })
    expect(await current.attachments.count()).toBe(0)
  } finally { await current.delete() }
})
