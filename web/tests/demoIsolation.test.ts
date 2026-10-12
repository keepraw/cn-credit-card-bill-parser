import { beforeEach, describe, expect, it } from 'vitest'
import { db } from '../src/db/db'
import {
  getArchiveStatus,
  persistImportResults,
  purgeDemoRows,
  readSnapshot,
} from '../src/db/repository'
import { buildDemoDataset } from '../src/demo/demoData'
import { clearDemoCache, getDemoSnapshot } from '../src/demo/demoStore'

async function clearDb(): Promise<void> {
  await db.transaction(
    'rw',
    [db.statements, db.transactions, db.imports, db.settings, db.attachments, db.reviewNotes],
    async () => {
      await db.statements.clear()
      await db.transactions.clear()
      await db.imports.clear()
      await db.settings.clear()
      await db.attachments.clear()
      await db.reviewNotes.clear()
    },
  )
}

const EMPTY_STATUS = { transactionCount: 0, importCount: 0, archivedCount: 0, missingCount: 0 }

beforeEach(async () => {
  clearDemoCache()
  await clearDb()
})

describe('fresh database', () => {
  it('starts empty with zero archive status', async () => {
    const snapshot = await readSnapshot()
    expect(snapshot.statements).toHaveLength(0)
    expect(snapshot.transactions).toHaveLength(0)
    expect(snapshot.imports).toHaveLength(0)
    expect(await getArchiveStatus()).toEqual(EMPTY_STATUS)
  })
})

describe('demo mode isolation', () => {
  it('serves demo data from memory without writing to Dexie', async () => {
    // Enabling demo mode: pages show the fictional dataset ...
    const demo = getDemoSnapshot()
    expect(demo.statements).toHaveLength(8)
    expect(demo.transactions).toHaveLength(94)
    expect(demo.imports.length).toBeGreaterThan(0)
    expect(demo.transactions.every((tx) => tx.isDemo)).toBe(true)
    expect(demo.statements.every((s) => s.isDemo)).toBe(true)

    // ... while the production tables stay empty.
    expect(await db.transactions.count()).toBe(0)
    expect(await db.statements.count()).toBe(0)
    expect(await db.imports.count()).toBe(0)

    // Disabling demo mode reports the real (empty) database state.
    expect(await getArchiveStatus()).toEqual(EMPTY_STATUS)
  })

  it('caches the snapshot per session', () => {
    expect(getDemoSnapshot()).toBe(getDemoSnapshot())
    clearDemoCache()
    expect(getDemoSnapshot().transactions).toHaveLength(94)
  })

  it('archive status ignores demo rows even before migration', async () => {
    // Legacy databases written by older versions still contain demo rows
    // until the next purge; the status must already report real data only.
    await persistImportResults(buildDemoDataset())
    expect(await db.transactions.count()).toBe(94)
    expect(await db.imports.count()).toBeGreaterThan(0)
    expect(await getArchiveStatus()).toEqual(EMPTY_STATUS)
  })
})

describe('legacy demo rows migration', () => {
  it('purge removes only fictional rows and keeps real data', async () => {
    // One real import with two real transactions (no evidence file).
    const [first] = buildDemoDataset()
    const realTransactions = first!.transactions.slice(0, 2).map((tx, index) => ({
      ...tx,
      id: `real-tx-${index}`,
      statementId: 'real-stmt',
      isDemo: false,
    }))
    await db.transactions.bulkPut(realTransactions)
    await db.imports.put({ ...first!.record, id: 'real-import', isDemo: false })
    // Legacy demo rows on top.
    await persistImportResults(buildDemoDataset())
    expect(await db.transactions.count()).toBe(94 + 2)

    await purgeDemoRows()

    expect(await db.transactions.count()).toBe(2)
    expect(await db.imports.count()).toBe(1)
    expect(await getArchiveStatus()).toEqual({
      transactionCount: 2,
      importCount: 1,
      archivedCount: 0,
      missingCount: 1,
    })
  })
})
