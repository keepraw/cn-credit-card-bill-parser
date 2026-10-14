import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render, waitFor } from '@testing-library/react'
import { AppProvider, useApp } from '../src/app/AppStore'
import { db, DEFAULT_SETTINGS, saveSettings } from '../src/db/db'
import { buildDemoDataset } from '../src/demo/demoData'
import { ensureDemoRowsPurged, persistImportResults } from '../src/db/repository'
import * as repository from '../src/db/repository'
import { ingestSynthetic } from './fixtures/identity'
import { sortTransactions } from '../src/ui/pages/TransactionsPage'
import { validateBackup } from '../src/backup/validation'
import type { Transaction } from '../src/core/types'

let app: ReturnType<typeof useApp>
function Probe() { app = useApp(); return null }
async function mount() {
  render(<AppProvider><Probe /></AppProvider>)
  await waitFor(() => expect(app.state.ready).toBe(true))
}
beforeEach(async () => {
  vi.restoreAllMocks()
  await db.transaction('rw', db.tables, async () => { for (const table of db.tables) await table.clear() })
  const first = ingestSynthetic(['消费 独立合成测试商户'])
  await db.imports.put({ ...first.record, isDemo: false })
  await db.statements.put({ ...first.statement!, isDemo: false })
  await db.transactions.put({ ...first.transactions[0]!, isDemo: false })
  await saveSettings(DEFAULT_SETTINGS)
})

describe('persisted ledger state', () => {
  it('loads one coherent snapshot and skips completed legacy cleanup on reopening', async () => {
    const reads = vi.spyOn(repository, 'readSnapshot')
    await mount()
    expect(reads).toHaveBeenCalledTimes(1)
    const filter = vi.spyOn(db.transactions, 'filter')
    await ensureDemoRowsPurged()
    expect(filter).not.toHaveBeenCalled()
    await persistImportResults(buildDemoDataset())
    await ensureDemoRowsPurged()
    expect(await db.transactions.filter(row => row.isDemo).count()).toBe(0)
    expect(await db.transactions.count()).toBe(1)
  })

  it('merges concurrent edits against committed rows without a snapshot read', async () => {
    await mount()
    const id = app.state.transactions[0]!.id, reads = vi.spyOn(repository, 'readSnapshot')
    const oldStatements = app.state.statements, oldImports = app.state.imports
    await act(async () => {
      await Promise.all([app.updateTransaction({ id, category: '旅行' }), app.updateTransaction({ id, reviewStatus: 'confirmed' })])
    })
    expect(reads).not.toHaveBeenCalled()
    expect(app.state.transactions[0]).toMatchObject({ category: '旅行', reviewStatus: 'confirmed' })
    expect(await db.transactions.get(id)).toEqual(app.state.transactions[0])
    expect(app.visibleTransactions[0]).toEqual(app.state.transactions[0])
    expect(app.state.statements).toBe(oldStatements)
    expect(app.state.imports).toBe(oldImports)
  })

  it('serializes a delayed refresh with a subsequent edit so stale reads cannot overwrite it', async () => {
    await mount()
    const id = app.state.transactions[0]!.id, captured = await repository.readSnapshot()
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    vi.spyOn(repository, 'readSnapshot').mockImplementationOnce(async () => { await gate; return captured })
    await act(async () => {
      const refreshed = app.refresh(), edited = app.updateTransaction({ id, category: '旅行' })
      release(); await Promise.all([refreshed, edited])
    })
    expect(app.state.transactions[0]!.category).toBe('旅行')
    expect(await db.transactions.get(id)).toEqual(app.state.transactions[0])
  })

  it('keeps UI unchanged on failed writes and permits the next operation', async () => {
    await mount()
    const prior = app.state.transactions[0]!, before = structuredClone(prior)
    vi.spyOn(db.transactions, 'put').mockRejectedValueOnce(new Error('synthetic quota failure'))
    await act(async () => { await expect(app.updateTransaction({ id: prior.id, category: '旅行' })).rejects.toThrow('quota') })
    expect(app.state.transactions[0]).toEqual(before)
    expect(await db.transactions.get(prior.id)).toEqual(before)
    await act(async () => { await app.updateTransaction({ id: prior.id, reviewStatus: 'confirmed' }) })
    expect(app.state.transactions[0]).toMatchObject({ category: before.category, reviewStatus: 'confirmed' })
  })

  it('merges preference patches, rolls back failed preferences and persists notes before changing state', async () => {
    await mount()
    await act(async () => { await Promise.all([app.setSettings({ theme: 'dark' }), app.setSettings({ locale: 'zh-CN' })]) })
    expect(app.state.settings.theme).toBe('dark')
    vi.spyOn(db.settings, 'put').mockRejectedValueOnce(new Error('synthetic settings quota'))
    await act(async () => { await expect(app.setSettings({ theme: 'light' })).rejects.toThrow('quota') })
    expect(app.state.settings.theme).toBe('dark')
    const id = app.state.transactions[0]!.id
    vi.spyOn(db.reviewNotes, 'put').mockRejectedValueOnce(new Error('synthetic quota'))
    await act(async () => { await expect(app.saveNote(id, ' note ')).rejects.toThrow('quota') })
    expect(app.state.notes[id]).toBeUndefined()
    await act(async () => { await app.saveNote(id, ' note ') })
    expect(app.state.notes[id]).toBe('note')
    await act(async () => { await app.saveNote(id, ' ') })
    expect(app.state.notes[id]).toBeUndefined()
    expect(await db.reviewNotes.get(id)).toBeUndefined()
  })
})

it('preserves historical list sorting, ties and filtered order for every supported key/direction', () => {
  const base = buildDemoDataset().flatMap(result => result.transactions)
  const rows: Transaction[] = base.flatMap((row, i) => [row, { ...row, id: `tie-${i}`, description: i % 2 ? '星巴克 Café 10' : 'amazon 2',
    postingDate: i % 3 ? row.postingDate : null, settlementAmountMinor: -row.settlementAmountMinor }]).reverse()
  for (const key of ['transactionDate', 'postingDate', 'description', 'settlementAmountMinor', 'type'] as const) {
    for (const direction of ['asc', 'desc'] as const) {
      const historical = [...rows].sort((a, b) => {
        const left = a[key], right = b[key]
        if (left === right) return (a.transactionDate ?? '').localeCompare(b.transactionDate ?? '')
        if (left === null) return 1
        if (right === null) return -1
        return String(left).localeCompare(String(right)) * (direction === 'asc' ? 1 : -1)
      })
      expect(sortTransactions(rows, key, direction).map(row => row.id)).toEqual(historical.map(row => row.id))
      expect(sortTransactions(rows, key, direction).filter(row => row.bank === 'boc')).toEqual(
        sortTransactions(rows.filter(row => row.bank === 'boc'), key, direction))
    }
  }
})

it('keeps identifier validation equivalent for Unicode, whitespace and control characters', async () => {
  const payload = await repository.exportDataBackup()
  const historical = (value: string) => value.length > 0 && value.length <= 256 && !/\s/.test(value) &&
    !Array.from(value).some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
  for (let code = 0; code <= 0xffff; code++) {
    const id = `synthetic-${String.fromCharCode(code)}`
    payload.transactions[0]!.id = id
    expect(validateBackup(payload)).toBe(historical(id))
  }
  for (const id of ['𝌆-合成-é', '', 'x'.repeat(257)]) {
    payload.transactions[0]!.id = id
    expect(validateBackup(payload)).toBe(historical(id))
  }
})
