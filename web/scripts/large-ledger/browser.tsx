import { useLayoutEffect } from 'react'
import { createRoot } from 'react-dom/client'
import { AppProvider, useApp } from '../../src/app/AppStore'
import { AppShell } from '../../src/ui/AppShell'
import { db, DEFAULT_SETTINGS } from '../../src/db/db'
import * as repository from '../../src/db/repository'
import { hashLegacyFile, planLegacyImport, previewLegacyWorkbook } from '../../src/importers/legacyImport'
import { validateBackup } from '../../src/backup/validation'
import { applyFilters, DEFAULT_FILTERS } from '../../src/core/analytics'
import { bankName, type Transaction } from '../../src/core/types'
import * as listModule from '../../src/ui/pages/TransactionsPage'
import '../../src/ui/theme.css'

const byteSize = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength
const now = () => performance.now()
const paint = () => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
let api: ReturnType<typeof useApp>
let commitAt = 0
const longTasks: Array<{ startTime: number; duration: number }> = []
new PerformanceObserver(list => { for (const entry of list.getEntries()) longTasks.push({ startTime: entry.startTime, duration: entry.duration }) }).observe({ type: 'longtask', buffered: true })

function Probe() {
  const current = useApp()
  api = current
  useLayoutEffect(() => { commitAt = now() }, [current.state.transactions])
  useLayoutEffect(() => { if (current.state.ready) window.dispatchEvent(new Event('benchmark-ready')) }, [current.state.ready])
  return <AppShell />
}
createRoot(document.getElementById('root')!).render(<AppProvider><Probe /></AppProvider>)

async function file(name: string) {
  const bytes = await (await fetch(`/__fixture/${name}`)).arrayBuffer()
  return new File([bytes], name, { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })
}
async function settleUsage() {
  const samples: number[] = []
  for (let i = 0; i < 5; i++) {
    samples.push((await navigator.storage.estimate()).usage ?? 0)
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  return { samples, usage: [...samples].sort((a, b) => a - b)[2]!, details: await navigator.storage.estimate() }
}
async function metrics() {
  const tables: Record<string, { count: number; jsonBytes: number; binaryBytes: number }> = {}
  const values: Record<string, unknown[]> = {}
  for (const table of db.tables) {
    const rows = await table.toArray()
    values[table.name] = rows
    const metadata = table.name === 'attachments' ? rows.map(({ data: _data, ...row }) => row) : rows
    tables[table.name] = { count: rows.length, jsonBytes: byteSize(metadata), binaryBytes: table.name === 'attachments' ? rows.reduce((sum, row) => sum + row.data.byteLength, 0) : 0 }
  }
  const snapshot = await repository.readSnapshot()
  const txs = snapshot.transactions
  const fields = Object.fromEntries(Object.keys(txs[0] ?? {}).map(key => {
    const vals = txs.map(tx => (tx as unknown as Record<string, unknown>)[key])
    const unique = new Set(vals.map(value => JSON.stringify(value)))
    const jsonValueBytes = vals.reduce<number>((sum, value) => sum + byteSize(value), 0)
    const marginalBytes = jsonValueBytes + txs.length * (byteSize(key) + 2) // quoted key + colon + comma
    return [key, { jsonValueBytes, marginalBytes, averageValueBytes: jsonValueBytes / txs.length,
      uniqueValues: unique.size, utf8TextBytes: vals.reduce<number>((sum, value) => sum + (typeof value === 'string' ? new TextEncoder().encode(value).length : 0), 0) }]
  }))
  const indexes = []
  for (const table of db.tables) {
    const native = db.backendDB().transaction(table.name).objectStore(table.name)
    const entries = []
    for (const name of Array.from(native.indexNames)) {
      const index = native.index(name)
      const count = await new Promise<number>((resolve, reject) => { const request = index.count(); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error) })
      entries.push({ name, keyPath: index.keyPath, unique: index.unique, count })
    }
    indexes.push({ table: table.name, primaryKey: table.schema.primKey.keyPath, indexes: entries })
  }
  const eq = (a: keyof typeof txs[number], b: keyof typeof txs[number]) => txs.filter(tx => tx[a] === tx[b]).length
  const statementIds = new Set(snapshot.statements.map(row => row.id))
  const importHashes = new Set(snapshot.imports.map(row => row.fileHash))
  const notes = await db.reviewNotes.toArray(), attachments = await db.attachments.toArray()
  const countBy = (key: keyof typeof txs[number]) => {
    const counts: Record<string, number> = {}; for (const tx of txs) { const value = String(tx[key]); counts[value] = (counts[value] ?? 0) + 1 } return counts
  }
  const counterfactuals = Object.fromEntries([
    ['rawDescription'], ['rawText'], ['merchant'], ['sourceFileName', 'sourceFileHash'],
    ['rawDescription', 'merchant'], ['rawDescription', 'rawText', 'merchant', 'sourceFileName', 'sourceFileHash'],
  ].map(keys => {
    // Serialization-only copies. No production object or stored row is altered.
    const bytes = byteSize(txs.map(tx => Object.fromEntries(Object.entries(tx).filter(([key]) => !keys.includes(key)))))
    return [keys.join('+'), { jsonBytes: bytes, savedBytes: tables.transactions!.jsonBytes - bytes }]
  }))
  return { tables, fields, indexes, counterfactuals, totalRecordsJsonBytes: Object.values(tables).reduce((sum, t) => sum + t.jsonBytes, 0),
    transactionObjectJsonBytes: txs.reduce((sum, tx) => sum + byteSize(tx), 0),
    equalities: { descriptionRawDescription: eq('description', 'rawDescription'), descriptionRawText: eq('description', 'rawText'), descriptionMerchant: eq('description', 'merchant') },
    distribution: { banks: countBy('bank'), types: countBy('type'), currencies: countBy('transactionCurrency'), flags: txs.filter(tx => tx.flags.length > 0).length,
      repeatedOccurrences: txs.filter(tx => tx.occurrence > 1).length, uniqueIds: new Set(txs.map(tx => tx.id)).size,
      crossCurrency: txs.filter(tx => tx.transactionCurrency !== tx.settlementCurrency).length, negative: txs.filter(tx => tx.settlementAmountMinor < 0).length },
    orphans: { transactions: txs.filter(tx => !statementIds.has(tx.statementId)).length, transactionSources: txs.filter(tx => !importHashes.has(tx.sourceFileHash)).length,
      notes: notes.filter(row => !txs.some(tx => tx.id === row.transactionId)).length, attachments: attachments.filter(row => !importHashes.has(row.fileHash)).length },
    usage: await settleUsage(), backupValid: validateBackup(await repository.exportDataBackup()) }
}

async function normalImport(name: string) {
  const input = await file(name) // fetch is intentionally outside import timing
  const start = now()
  const preview = await api.previewLegacyImport(input)
  const previewEnd = now()
  const record = await api.confirmLegacyImport(preview)
  const confirmEnd = now()
  await paint()
  return { previewMs: previewEnd - start, confirmMs: confirmEnd - previewEnd, totalMs: now() - start,
    record: { status: record.status, transactionCount: record.transactionCount }, valid: preview.stats.validRows, anomalies: preview.anomalies.length,
    longTasks: longTasks.filter(t => t.startTime >= start) }
}
async function components(name: string) {
  const input = await file(name), empty = { transactions: [], statements: [], imports: [] }
  let start = now(); const { buffer, fileHash } = await hashLegacyFile(input); const hashMs = now() - start
  start = now(); const preview = await previewLegacyWorkbook(buffer, { fileName: input.name, fileSize: input.size, fileHash }, empty); const previewMs = now() - start
  start = now(); const plan = planLegacyImport(preview, empty); const planMs = now() - start
  return { hashMs, previewMs, planMs, plan }
}

async function performanceSamples(repeats: number) {
  const samples = []
  // Warm modules and methods once; each recorded read still issues real IndexedDB requests.
  await repository.readSnapshot()
  for (let i = 0; i < repeats; i++) {
    let start = now(); const snapshot = await repository.readSnapshot(); const readMs = now() - start
    start = now(); const all = applyFilters(snapshot.transactions, DEFAULT_FILTERS).filter(() => true)
    const filterAllMs = now() - start
    start = now(); const productionSort = Reflect.get(listModule, 'sortTransactions') as ((rows: typeof all, key: string, dir: string) => typeof all) | undefined
    if (productionSort) productionSort(all, 'transactionDate', 'desc')
    else all.sort((a, b) => {
      const left = a.transactionDate, right = b.transactionDate
      if (left === right) return (a.transactionDate ?? '').localeCompare(b.transactionDate ?? '')
      if (left === null) return 1; if (right === null) return -1
      return String(left).localeCompare(String(right)) * -1
    }); const dateSortMs = now() - start
    start = now(); const selected = applyFilters(snapshot.transactions, { ...DEFAULT_FILTERS, banks: ['boc'], from: '2023-01-01', to: '2025-12-31' }).filter(tx =>
      tx.description.toLowerCase().includes('咖啡') || tx.merchant.toLowerCase().includes('咖啡') || tx.cardLast4.includes('咖啡') || bankName(tx.bank).includes('咖啡'))
    const filteredSearchMs = now() - start
    start = now(); if (productionSort) productionSort(snapshot.transactions, 'description', 'asc')
    else [...snapshot.transactions].sort((a, b) => a.description === b.description ? (a.transactionDate ?? '').localeCompare(b.transactionDate ?? '') : String(a.description).localeCompare(String(b.description)))
    const descriptionSortMs = now() - start
    start = now(); const payload = await repository.exportDataBackup(); const backupReadMs = now() - start
    start = now(); const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }); const backupEncodeBlobMs = now() - start
    const refreshStart = now(); await api.refresh(); const refreshResolvedMs = now() - refreshStart
    await paint(); const refreshPaintMs = now() - refreshStart
    samples.push({ readMs, filterAllMs, dateSortMs, filteredSearchMs, descriptionSortMs, filteredRecords: selected.length,
      backupReadMs, backupEncodeBlobMs, backupTotalMs: backupReadMs + backupEncodeBlobMs, backupBytes: blob.size,
      refreshResolvedMs, refreshCommitMs: commitAt - refreshStart, refreshPaintMs })
  }
  return samples
}

async function scratch(name: string, indexed: boolean) {
  const { plan, ...timings } = await components(name)
  const schema = db.tables.map(table => ({ name: table.name, primary: table.schema.primKey.keyPath,
    indexes: table.schema.indexes.map(index => ({ name: index.name, keyPath: index.keyPath, unique: index.unique, multiEntry: index.multi })) }))
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('synthetic-index-control', 1)
    request.onupgradeneeded = () => { for (const table of schema) {
      const store = request.result.createObjectStore(table.name, { keyPath: table.primary })
      if (indexed) for (const index of table.indexes) {
        if (index.keyPath === undefined) throw new Error(`Missing index key path: ${index.name}`)
        store.createIndex(index.name, index.keyPath, { unique: index.unique, multiEntry: index.multiEntry })
      }
    } }
    request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error)
  })
  const baseline = await settleUsage()
  const start = now()
  await new Promise<void>((resolve, reject) => {
    const tx = database.transaction(['transactions', 'statements', 'imports'], 'readwrite')
    for (const row of plan.inserted) tx.objectStore('transactions').add(row)
    for (const row of plan.statements) tx.objectStore('statements').add(row)
    tx.objectStore('imports').add(plan.record)
    tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error)
  })
  database.close()
  return { ...timings, indexed, records: plan.inserted.length, persistenceMs: now() - start, baseline, after: await settleUsage() }
}

async function lifecycle(name: string, alternate: string) {
  const stages: Array<{ label: string; counts: Record<string, number>; usage: Awaited<ReturnType<typeof settleUsage>> }> = []
  const checkpoint = async (label: string) => {
    stages.push({ label, counts: Object.fromEntries(await Promise.all(db.tables.map(async t => [t.name, await t.count()]))), usage: await settleUsage() })
  }
  await checkpoint('initial')
  for (let i = 0; i < 5; i++) { await normalImport(name); await checkpoint(`identical-import-${i + 1}`) }
  await normalImport(alternate); await checkpoint('different-hash-same-business-rows')
  const tx = (await repository.readSnapshot()).transactions[0]!
  for (let i = 0; i < 10; i++) { await api.updateTransaction({ id: tx.id, category: i % 2 ? tx.category : '其他' }); await api.saveNote(tx.id, `合成测试备注 ${i}`); await api.backupData() }
  await checkpoint('ten-edit-note-backup-cycles')
  await api.saveNote(tx.id, ''); await checkpoint('delete-synthetic-note')
  const snapshot = await repository.readSnapshot()
  const imports = snapshot.imports.filter(record => record.status === 'duplicate')
  return { stages, duplicateRecords: imports.map(record => ({ id: record.id, transactionCount: record.transactionCount, duplicateOf: record.duplicateOf })), metrics: await metrics() }
}

async function attachmentExperiment(name: string) {
  const input = await file(name), { buffer, fileHash } = await hashLegacyFile(input)
  const record = (await db.imports.toArray()).find(row => row.fileHash === fileHash)!
  const before = await settleUsage()
  for (let i = 0; i < 5; i++) await repository.saveOriginalFile({ fileName: name, fileHash, data: buffer, importId: record.id, parserId: record.parserId })
  return { before, after: await metrics(), inputBytes: buffer.byteLength }
}

Object.assign(window, { benchmark: {
  ready: () => Boolean(api?.state.ready), count: () => api?.state.transactions.length ?? 0,
  disableDemo: async () => { await api.setSettings({ ...DEFAULT_SETTINGS, demoMode: false }); await paint() },
  metrics, normalImport, performanceSamples, components: async (name: string) => { const { plan: _plan, ...result } = await components(name); return result },
  persistenceSample: async () => {
    const snapshot = await repository.readSnapshot(), record = snapshot.imports[0]!
    await db.transaction('rw', db.transactions, db.statements, db.imports, async () => { await db.transactions.clear(); await db.statements.clear(); await db.imports.clear() })
    const start = now(); await repository.persistLegacyImport({ record, statements: snapshot.statements, inserted: snapshot.transactions }); return now() - start
  },
  lifecycle, attachmentExperiment, scratch, usage: settleUsage,
  backupRoundTrip: async () => {
    const payload = await repository.exportDataBackup()
    const input = new File([JSON.stringify(payload, null, 2)], 'synthetic-self-backup.json', { type: 'application/json' })
    return { bytes: input.size, result: await api.restore(input) }
  },
  openMs: async () => { db.close(); const start = now(); await db.open(); return now() - start },
  restoreFile: async (name: string) => {
    const input = await file(name), start = now()
    const result = await api.restore(input)
    await paint()
    return { ...result, ms: now() - start }
  },
  exportFile: async (kind: string) => {
    const start = now()
    if (kind === 'zip') await api.backupFull(); else await api.backupData()
    return now() - start
  },
  clear: async () => { await api.clearData(true); await paint(); return Object.fromEntries(await Promise.all(db.tables.map(async t => [t.name, await t.count()]))) },
  stateRow: (id: string) => api.state.transactions.find(row => row.id === id),
  edit: async (id: string, category: string, status: string) => {
    await api.updateTransaction({ id, category: category as '旅行', reviewStatus: status as 'confirmed', flags: [] })
    await paint()
    return { state: api.state.transactions.find(row => row.id === id), stored: await db.transactions.get(id) }
  },
  note: async (id: string) => { await api.saveNote(id, '完全合成的已有备注，恢复不得覆盖'); await paint() },
  originals: async (name: string) => {
    const input = await file(name), { buffer, fileHash } = await hashLegacyFile(input)
    const record = (await db.imports.toArray()).find(row => row.fileHash === fileHash)!
    await repository.saveOriginalFile({ fileName: name, fileHash, data: buffer, importId: record.id, parserId: record.parserId })
  },
  rows: async (table: string, after: string | null) => {
    const t = db.table(table), key = t.schema.primKey.keyPath as string
    const values = await (after === null ? t.toCollection() : t.where(':id').above(after)).limit(2000).toArray()
    return Promise.all(values.map(async row => {
      if (table !== 'attachments') return { ...row, __key: row[key] }
      const digest = await crypto.subtle.digest('SHA-256', row.data)
      const { data: _data, ...metadata } = row
      return { ...metadata, __key: row[key], binaryBytes: row.data.byteLength,
        binaryHash: [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('') }
    }))
  },
  verify: async (name: string, extras: { notes: Record<string, unknown>[]; attachments: Record<string, unknown>[] }, format: string, existing: boolean, override: { id: string; category: string; reviewStatus: string } | null) => {
    const expected = JSON.parse(await (await fetch(`/__fixture/${name}`)).text()) as repository.BackupPayload
    const actual = await repository.readSnapshot()
    const counts = { transactionCountMismatches: Math.abs(expected.transactions.length - actual.transactions.length), idMismatches: 0,
      amountMismatches: 0, currencyMismatches: 0, duplicateRelationshipMismatches: 0, missingStatements: 0,
      missingAttachments: 0, lostReviewStates: 0, otherTransactionMismatches: 0, statementMismatches: 0,
      importMismatches: 0, noteMismatches: 0, attachmentMismatches: 0 }
    const byId = new Map(actual.transactions.map(row => [row.id, row]))
    const statements = new Set(actual.statements.map(row => row.id))
    for (const original of expected.transactions) {
      const row: Transaction = override?.id === original.id ? { ...original, category: override.category as '医疗健康', reviewStatus: override.reviewStatus as 'rejected', flags: [] } : original
      const got = byId.get(row.id)
      if (!got) { counts.idMismatches++; continue }
      if (got.id !== row.id) counts.idMismatches++
      if (got.transactionAmountMinor !== row.transactionAmountMinor || got.settlementAmountMinor !== row.settlementAmountMinor) counts.amountMismatches++
      if (got.transactionCurrency !== row.transactionCurrency || got.settlementCurrency !== row.settlementCurrency) counts.currencyMismatches++
      if (got.fingerprint !== row.fingerprint || got.occurrence !== row.occurrence) counts.duplicateRelationshipMismatches++
      if (got.category !== row.category || got.reviewStatus !== row.reviewStatus || JSON.stringify(got.flags) !== JSON.stringify(row.flags)) counts.lostReviewStates++
      if (!statements.has(row.statementId)) counts.missingStatements++
      if (JSON.stringify(got) !== JSON.stringify(row)) counts.otherTransactionMismatches++
    }
    for (const table of ['statements', 'imports'] as const) {
      const rows = new Map(actual[table].map(row => [row.id, JSON.stringify(row)]))
      const field = table === 'statements' ? 'statementMismatches' : 'importMismatches'
      if (actual[table].length !== expected[table].length) counts[field]++
      for (const row of expected[table]) if (rows.get(row.id) !== JSON.stringify(row)) counts[field]++
    }
    const clean = (row: object, attachment: boolean) => Object.fromEntries(Object.entries(row).filter(([key]) => !['__key', 'binaryHash', 'binaryBytes', 'data'].includes(key) && !(attachment && !existing && key === 'importedAt')))
    const notes = existing ? extras.notes : []
    const storedNotes = await db.reviewNotes.toArray()
    if (notes.length !== storedNotes.length) counts.noteMismatches++
    for (const row of notes) {
      const got = storedNotes.find(note => note.transactionId === row.transactionId)
      if (!got || JSON.stringify(clean(row, false)) !== JSON.stringify(got)) counts.noteMismatches++
    }
    const files = existing || format === 'zip' ? extras.attachments : []
    const storedFiles = await db.attachments.toArray()
    if (files.length !== storedFiles.length) counts.missingAttachments += Math.abs(files.length - storedFiles.length)
    for (const row of files) {
      const got = storedFiles.find(file => file.fileHash === row.fileHash)
      if (!got) { counts.missingAttachments++; continue }
      const digest = await crypto.subtle.digest('SHA-256', got.data)
      const hash = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('')
      if (got.data.byteLength !== row.binaryBytes || hash !== row.binaryHash) counts.missingAttachments++
      if (JSON.stringify(clean(row, true)) !== JSON.stringify(clean(got, true))) counts.attachmentMismatches++
    }
    return counts
  },
  counts: async () => Object.fromEntries(await Promise.all(db.tables.map(async t => [t.name, await t.count()]))),
  editSamples: async (repeats: number) => {
    const id = api.state.transactions[0]!.id, samples = []
    for (let i = 0; i < repeats; i++) {
      let reads = 0
      const original = db.transactions.toArray.bind(db.transactions)
      db.transactions.toArray = () => { reads++; return original() }
      try {
        const start = now()
        await api.updateTransaction({ id, category: i % 2 ? '旅行' : '购物' })
        const resolvedMs = now() - start
        await paint()
        samples.push({ resolvedMs, commitMs: commitAt - start, paintMs: now() - start, fullReads: reads })
      } finally { db.transactions.toArray = original }
    }
    return samples
  },
  attachmentFailure: async (name: string) => {
    const input = await file(name), original = db.attachments.put
    db.attachments.put = () => { throw new DOMException('synthetic late quota error', 'QuotaExceededError') }
    const start = now()
    try { return { ...await api.restore(input), ms: now() - start } }
    finally { db.attachments.put = original }
  },
} })
