import { chromium } from '@playwright/test'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, readFile, writeFile, cp, readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// Supplemental analysis on copies of this runner's synthetic profiles only.
// No application schema, live record, or original benchmark profile is changed.
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const resultsPath = process.argv[2] ?? path.join(repo, 'docs/benchmarks/storage-results.json')
const source = JSON.parse(await readFile(resultsPath, 'utf8'))
const directory = source.metadata.temporary
if (!path.basename(directory).startsWith('keepraw-storage-')) throw new Error('Not a synthetic benchmark directory')
const root = await mkdtemp(path.join(path.dirname(directory), 'keepraw-storage-maintenance-'))
const origin = source.metadata.origin
const output = { sourceCommit: source.metadata.commit, sourceResults: path.basename(resultsPath), date: new Date().toISOString(), root, cycles: [], legacyDemo: null }
const dist = path.join(directory, 'dist')
const contexts = new Set()
const log = message => process.stdout.write(`${new Date().toISOString()} ${message}\n`)
const server = createServer(async (request, response) => {
  const pathname = new URL(request.url, origin).pathname
  if (pathname === '/read-only') { response.setHeader('Content-Type', 'text/html'); response.end('<!doctype html><title>Synthetic read-only measurement</title>'); return }
  const target = path.resolve(dist, `.${pathname === '/' ? '/index.html' : pathname}`)
  if (!target.startsWith(dist + path.sep)) { response.statusCode = 404; response.end(); return }
  try { response.setHeader('Content-Type', target.endsWith('.html') ? 'text/html' : target.endsWith('.js') ? 'text/javascript' : target.endsWith('.css') ? 'text/css' : 'application/octet-stream'); response.end(await readFile(target)) }
  catch { response.statusCode = 404; response.end() }
})
await new Promise(resolve => server.listen(Number(new URL(origin).port), '127.0.0.1', resolve))
const launch = async profile => {
  const context = await chromium.launchPersistentContext(profile, { executablePath: process.env.CHROMIUM_PATH ?? '/usr/bin/chromium', headless: true, locale: 'zh-CN', args: ['--no-sandbox', '--disable-dev-shm-usage'] })
  contexts.add(context); context.on('close', () => contexts.delete(context))
  await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort())
  return context
}
async function disk(profile) {
  const directory = path.join(profile, 'Default/IndexedDB'), files = []
  const walk = async folder => { for (const entry of await readdir(folder, { withFileTypes: true }).catch(() => [])) {
    const full = path.join(folder, entry.name)
    if (entry.isDirectory()) await walk(full)
    else { const info = await stat(full); files.push({ path: path.relative(directory, full), bytes: info.size, allocatedBytes: info.blocks * 512 }) }
  } }
  await walk(directory)
  return { fileBytes: files.reduce((sum, file) => sum + file.bytes, 0), allocatedBytes: files.reduce((sum, file) => sum + file.allocatedBytes, 0), files }
}
async function inspect(page) {
  return page.evaluate(async () => {
    const databases = {}, samples = []
    let seed = null
    for (const entry of await indexedDB.databases()) {
      const database = await new Promise((resolve, reject) => { const request = indexedDB.open(entry.name); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error) })
      const rows = {}
      let statements = []
      for (const name of database.objectStoreNames) {
        const tx = database.transaction(name, 'readonly'), store = tx.objectStore(name)
        const values = await new Promise((resolve, reject) => { const request = store.getAll(); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error) })
        const metadata = name === 'attachments' ? values.map(({ data: _data, ...row }) => row) : values
        rows[name] = { count: values.length, jsonBytes: new TextEncoder().encode(JSON.stringify(metadata)).length, binaryBytes: name === 'attachments' ? values.reduce((sum, row) => sum + row.data.byteLength, 0) : 0 }
        if (name === 'transactions' && values.length) seed = { transaction: values[0] }
        if (name === 'statements') statements = values
        if (name === 'imports' && values.length) rows[name].first = values[0]
      }
      if (seed && database.name === 'credit-bill-manager') {
        seed.statement = statements.find(row => row.id === seed.transaction.statementId); seed.record = rows.imports.first
      }
      for (const row of Object.values(rows)) delete row.first
      databases[database.name] = rows
      database.close()
    }
    for (let i = 0; i < 5; i++) { samples.push((await navigator.storage.estimate()).usage ?? 0); await new Promise(resolve => setTimeout(resolve, 100)) }
    return { databases, usageSamples: samples, usage: [...samples].sort((a, b) => a - b)[2], seed }
  })
}
let seed
try {
  const names = ['python-18000-1', 'python-18000-2', 'python-100000-1', 'python-100000-2', ...source.controls.map(row => `index-control-${row.indexed}-${row.replicate}`)]
  for (const name of names) {
    log(`READ-ONLY ${name}`)
    const profile = path.join(root, name)
    await mkdir(path.join(profile, 'Default'), { recursive: true })
    await cp(path.join(directory, name, 'Default/IndexedDB'), path.join(profile, 'Default/IndexedDB'), { recursive: true })
    const record = { name, originalDisk: await disk(profile), checkpoints: [] }
    for (let cycle = 0; cycle < 3; cycle++) {
      const context = await launch(profile), page = context.pages()[0]
      await page.goto(origin + '/read-only')
      const { seed: candidate, ...measurement } = await inspect(page)
      if (name === 'python-18000-1' && candidate) seed = candidate
      await context.close()
      record.checkpoints.push({ cycle, ...measurement, disk: await disk(profile) })
    }
    output.cycles.push(record)
    await writeFile(path.join(repo, 'docs/benchmarks/storage-maintenance-results.json'), JSON.stringify(output, null, 2) + '\n')
  }
  log('SIMULATED OLD DEMO ROWS')
  const context = await launch(path.join(root, 'legacy-demo-orphans')), page = context.pages()[0]
  await page.goto(origin + '/#/settings')
  await page.getByTestId('demo-toggle').waitFor()
  await page.goto(origin + '/read-only')
  await page.evaluate(async seed => {
    const raw = new TextEncoder().encode(`虚构旧版演示账单\n${seed.transaction.rawText}`).buffer
    const digest = await crypto.subtle.digest('SHA-256', raw)
    const fileHash = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('')
    const fileName = 'synthetic-old-demo.txt'
    const txRow = { ...seed.transaction, sourceFileName: fileName, sourceFileHash: fileHash, isDemo: true }
    const statement = { ...seed.statement, transactionCount: 1, sourceFileName: fileName, sourceFileHash: fileHash, isDemo: true }
    const record = { ...seed.record, id: fileHash + ':synthetic-old-demo', fileHash, fileName, sourceType: 'text', fileSize: raw.byteLength, transactionCount: 1, isDemo: true }
    const db = await new Promise((resolve, reject) => { const request = indexedDB.open('credit-bill-manager'); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error) })
    await new Promise((resolve, reject) => {
      const transaction = db.transaction(['transactions', 'statements', 'imports', 'reviewNotes', 'attachments'], 'readwrite')
      transaction.objectStore('transactions').put(txRow); transaction.objectStore('statements').put(statement); transaction.objectStore('imports').put(record)
      transaction.objectStore('reviewNotes').put({ transactionId: txRow.id, note: '完全虚构的旧版演示备注', updatedAt: '2020-01-01T00:00:00Z' })
      transaction.objectStore('attachments').put({ fileHash, fileName, size: raw.byteLength, mimeType: 'text/plain', data: raw, importId: record.id, parserId: record.parserId, importedAt: '2020-01-01T00:00:00Z' })
      transaction.oncomplete = () => resolve(); transaction.onabort = () => reject(transaction.error)
    }); db.close()
  }, seed)
  const { seed: _beforeSeed, ...before } = await inspect(page)
  await page.goto(origin + '/#/settings')
  await page.getByTestId('demo-toggle').waitFor()
  await page.goto(origin + '/read-only')
  const { seed: _afterSeed, ...after } = await inspect(page)
  output.legacyDemo = { before, after, note: 'Only simulated old persisted demo provenance. Current normal imports had zero orphans.' }
  await context.close()
  await writeFile(path.join(repo, 'docs/benchmarks/storage-maintenance-results.json'), JSON.stringify(output, null, 2) + '\n')
  log('DONE')
} finally {
  for (const context of contexts) await context.close().catch(() => {})
  await new Promise(resolve => server.close(resolve))
}
