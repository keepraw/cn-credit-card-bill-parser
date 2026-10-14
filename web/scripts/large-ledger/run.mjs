import { build } from 'vite'
import { chromium } from '@playwright/test'
import JSZip from 'jszip'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, writeFile, readFile, stat, rm } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import assert from 'node:assert/strict'
import { SEED, makeRows, makeWorkbook } from '../storage-benchmark/fixture.mjs'

const directory = path.dirname(fileURLToPath(import.meta.url)), ownWeb = path.resolve(directory, '../..')
const web = path.resolve(process.env.LEDGER_WEB_ROOT ?? ownWeb), repo = path.resolve(ownWeb, '..')
const mode = process.env.LEDGER_MODE ?? 'backup'
const sizes = (process.env.LEDGER_SIZES ?? (mode === 'backup' ? '18000,36000,100000' : '18000,100000')).split(',').map(Number)
const output = process.env.LEDGER_OUTPUT ?? path.join(repo, `docs/benchmarks/large-ledger-${mode}.json`)
await mkdir('/workspace/scratch', { recursive: true })
const temporary = await mkdtemp('/workspace/scratch/large-ledger-'), buildDirectory = path.join(web, 'scripts/large-ledger')
await mkdir(buildDirectory, { recursive: true })
const generated = path.join(buildDirectory, '.generated.html'), generatedProbe = path.join(buildDirectory, '.generated-probe.tsx')
const dist = path.join(temporary, 'dist'), assets = new Map(), contexts = new Set()
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const log = value => process.stdout.write(`${new Date().toISOString()} ${value}\n`)
const result = { metadata: { date: new Date().toISOString(), mode, seed: SEED, source: web,
  commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: web, encoding: 'utf8' }).trim(),
  node: process.version, cpu: os.cpus()[0].model, cpus: os.cpus().length, memoryBytes: os.totalmem(), temporary }, cases: [] }
result.metadata.sourceFiles = {}
for (const name of ['app/AppStore.tsx', 'db/db.ts', 'db/repository.ts', 'backup/json.ts', 'backup/archive.ts', 'backup/zipSafety.ts', 'ui/pages/TransactionsPage.tsx']) {
  const file = path.join(web, 'src', name)
  if (await stat(file).catch(() => null)) result.metadata.sourceFiles[name] = hash(await readFile(file))
}
const save = async () => { await mkdir(path.dirname(output), { recursive: true }); await writeFile(output, JSON.stringify(result, null, 2) + '\n') }
const call = (page, method, ...args) => page.evaluate(async ({ method, args }) => window.benchmark[method](...args), { method, args })
let server, origin
async function launch(name) {
  const profile = path.join(temporary, name)
  const context = await chromium.launchPersistentContext(profile, { executablePath: process.env.CHROMIUM_PATH ?? '/usr/bin/chromium',
    headless: true, locale: 'zh-CN', timezoneId: 'UTC', acceptDownloads: true,
    viewport: { width: 1440, height: 1000 }, args: ['--no-sandbox', '--disable-dev-shm-usage'] })
  contexts.add(context); context.on('close', () => contexts.delete(context))
  await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort())
  const page = context.pages()[0]; page.setDefaultTimeout(180000)
  const memory = { peakChromiumRssBytes: 0, peakNodeRssBytes: 0, peakSamples: [] }
  if (mode === 'backup') {
    const session = await context.browser().newBrowserCDPSession()
    let closed = false; context.on('close', () => { closed = true })
    void (async () => {
      while (!closed) {
        try {
          const { processInfo } = await session.send('SystemInfo.getProcessInfo')
          const pids = processInfo.map(info => info.id).filter(id => Number.isInteger(id) && id > 0)
          const text = execFileSync('ps', ['-o', 'rss=', '-p', pids.join(',')], { encoding: 'utf8' })
          const rss = text.trim().split(/\s+/).reduce((sum, value) => sum + Number(value) * 1024, 0)
          if (rss > memory.peakChromiumRssBytes) { memory.peakChromiumRssBytes = rss; memory.peakSamples.push({ at: new Date().toISOString(), bytes: rss }) }
          memory.peakNodeRssBytes = Math.max(memory.peakNodeRssBytes, process.memoryUsage().rss)
        } catch { if (closed) break }
        await new Promise(resolve => setTimeout(resolve, 250))
      }
    })()
  }
  page.on('pageerror', error => log(`PAGE ERROR: ${error.message}`))
  await page.goto(`${origin}/scripts/large-ledger/.generated.html#/transactions`)
  await page.waitForFunction(() => window.benchmark?.ready())
  await call(page, 'disableDemo')
  return { context, page, profile, memory }
}
async function verified(page, name, extras, format = 'database', existing = false, override = null) {
  const counts = await call(page, 'verify', name, extras, format, existing, override)
  for (const [key, value] of Object.entries(counts)) assert.equal(value, 0, key)
  return counts
}
async function exported(page, kind, name) {
  const download = page.waitForEvent('download', { timeout: 180000 })
  const ms = await call(page, 'exportFile', kind)
  const item = await download, bytes = await readFile(await item.path())
  assets.set(name, bytes)
  return { bytes: bytes.length, ms, sha256: hash(bytes) }
}
async function backupCase(count) {
  log(`BACKUP ${count}`)
  const workbookName = `python-${count}.xlsx`, fixture = makeWorkbook(makeRows(count)); assets.set(workbookName, fixture)
  const source = await launch(`source-${count}`), entry = { count, import: await call(source.page, 'normalImport', workbookName), checks: [], restore: [], memoryProfiles: [] }
  const first = (await call(source.page, 'rows', 'transactions', null))[0]
  await call(source.page, 'edit', first.id, '旅行', 'confirmed'); await call(source.page, 'note', first.id); await call(source.page, 'originals', workbookName)
  const extras = { notes: await call(source.page, 'rows', 'reviewNotes', null), attachments: await call(source.page, 'rows', 'attachments', null) }
  assert.equal((await call(source.page, 'counts')).transactions, count)
  entry.json = await exported(source.page, 'json', `${count}.json`); entry.zip = await exported(source.page, 'zip', `${count}.zip`)
  log(`EXPORT ${count}: JSON=${entry.json.bytes} ZIP=${entry.zip.bytes}`)
  await call(source.page, 'edit', first.id, '医疗健康', 'rejected')
  const override = { id: first.id, category: '医疗健康', reviewStatus: 'rejected' }
  for (const name of [`${count}.json`, `${count}.zip`]) {
    const restored = await call(source.page, 'restoreFile', name); assert.equal(restored.ok, true, restored.message)
    entry.restore.push({ context: 'existing-edits-notes-originals', name, ...restored })
    entry.checks.push({ context: 'existing', ...await verified(source.page, `${count}.json`, extras, 'database', true, override) })
  }
  const empty = await call(source.page, 'clear')
  for (const table of ['transactions', 'statements', 'imports', 'reviewNotes', 'attachments']) assert.equal(empty[table], 0)
  const cleared = await call(source.page, 'restoreFile', `${count}.json`); assert.equal(cleared.ok, true, cleared.message)
  entry.restore.push({ context: 'export-clear-restore', kind: 'json', ...cleared })
  entry.checks.push({ context: 'clear-json', ...await verified(source.page, `${count}.json`, extras, 'json') })
  await source.context.close(); entry.memoryProfiles.push({ label: 'source', ...source.memory })
  for (const kind of ['json', 'zip']) {
    const target = await launch(`fresh-${kind}-${count}`)
    if (kind === 'zip' && count === 100000) {
      const failed = await call(target.page, 'attachmentFailure', `${count}.zip`); assert.equal(failed.ok, false)
      const state = await call(target.page, 'counts')
      for (const table of ['transactions', 'statements', 'imports', 'attachments']) assert.equal(state[table], 0, 'late error must roll back')
      entry.lateRollback = { failed, counts: state }; log('100k native late-attachment rollback passed')
    }
    for (let repeat = 0; repeat < 3; repeat++) {
      const restored = await call(target.page, 'restoreFile', `${count}.${kind}`); assert.equal(restored.ok, true, restored.message)
      entry.restore.push({ context: 'fresh-profile', kind, repeat, ...restored })
      entry.checks.push({ context: `fresh-${kind}-${repeat}`, ...await verified(target.page, `${count}.json`, extras, kind) })
      log(`RESTORE ${count} ${kind} ${repeat}: ${restored.ms.toFixed(1)}ms`)
    }
    await target.context.close(); entry.memoryProfiles.push({ label: `fresh-${kind}`, ...target.memory })
  }
  const legacyPayload = JSON.parse(assets.get(`${count}.json`).toString('utf8'))
  legacyPayload.format = 'credit-bill-manager-backup'; legacyPayload.settings = { demoMode: false, theme: 'dark' }
  const legacyText = JSON.stringify(legacyPayload, null, 2); assets.set(`${count}-legacy.json`, Buffer.from(legacyText))
  const currentZip = await JSZip.loadAsync(assets.get(`${count}.zip`)), legacyZip = new JSZip()
  for (const [name, file] of Object.entries(currentZip.files)) if (!file.dir) legacyZip.file(name, name === 'database.json' ? legacyText : await file.async('uint8array'))
  assets.set(`${count}-legacy.zip`, await legacyZip.generateAsync({ type: 'nodebuffer', compression: 'STORE' }))
  for (const kind of ['json', 'zip']) {
    const target = await launch(`legacy-${kind}-${count}`)
    const restored = await call(target.page, 'restoreFile', `${count}-legacy.${kind}`); assert.equal(restored.ok, true, restored.message)
    entry.restore.push({ context: 'legacy-v1', kind, bytes: assets.get(`${count}-legacy.${kind}`).length, ...restored })
    entry.checks.push({ context: `legacy-${kind}`, ...await verified(target.page, `${count}.json`, extras, kind) })
    await target.context.close(); entry.memoryProfiles.push({ label: `legacy-${kind}`, ...target.memory })
  }
  entry.contract = { version: 1, notesExported: false, existingNotesPreserved: true, freshZipAttachmentTimestampReconstructed: true }
  result.cases.push(entry); await save(); log(`PASS BACKUP ${count}`)
  for (const key of [...assets.keys()]) if (key.startsWith(String(count)) || key === workbookName) assets.delete(key)
}
async function uiSamples(page) {
  const samples = []
  const measure = async (kind, action) => {
    const pending = page.evaluate(kind => new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('UI event timeout')), 20000)
      document.addEventListener(kind, () => { clearTimeout(timeout); const start = performance.now(); requestAnimationFrame(() => requestAnimationFrame(() => resolve(performance.now() - start))) }, { capture: true, once: true })
    }), kind)
    await action(); return pending
  }
  for (let i = 0; i < 5; i++) {
    const searchMs = await measure('input', () => page.getByTestId('transaction-search').fill('咖啡')); await page.getByTestId('transaction-search').fill('')
    const dateSortMs = await measure('click', () => page.locator('th.sortable').filter({ hasText: '交易日' }).click())
    const descriptionSortMs = await measure('click', () => page.locator('th.sortable').filter({ hasText: '交易描述' }).click())
    samples.push({ searchMs, dateSortMs, descriptionSortMs })
  }
  return samples
}
async function performanceCase(count) {
  const name = `python-${count}.xlsx`; assets.set(name, makeWorkbook(makeRows(count)))
  const entry = { count, imports: [], samples: [], startup: [], edits: [], ui: [] }
  for (let repeat = 0; repeat < 3; repeat++) {
    log(`PERFORMANCE ${count} ${repeat}`); const target = await launch(`performance-${count}-${repeat}`)
    entry.imports.push(await call(target.page, 'normalImport', name)); entry.usage ??= await call(target.page, 'usage')
    if (repeat === 0) {
      entry.samples = await call(target.page, 'performanceSamples', 5); entry.edits = await call(target.page, 'editSamples', 5); entry.ui = await uiSamples(target.page)
      entry.actualBackup = []; for (let i = 0; i < 3; i++) entry.actualBackup.push(await exported(target.page, 'json', `${count}-performance.json`))
      for (let i = 0; i < 3; i++) {
        const page = await target.context.newPage()
        await page.addInitScript(count => { const observer = new MutationObserver(() => {
          if (document.querySelector('.page-head p')?.textContent.startsWith(`共 ${count} 笔`)) { window.firstReady = performance.now(); observer.disconnect() }
        }); observer.observe(document, { childList: true, subtree: true, characterData: true }) }, count)
        await page.goto(origin + '/#/transactions'); await page.waitForFunction(() => window.firstReady !== undefined, undefined, { timeout: 180000 })
        entry.startup.push(await page.evaluate(() => window.firstReady)); await page.close()
      }
    }
    await target.context.close()
  }
  result.cases.push(entry); await save()
}
try {
  await writeFile(generatedProbe, await readFile(path.join(directory, 'browser.tsx'), 'utf8'))
  await writeFile(generated, '<!doctype html><html lang="zh-CN"><meta charset="UTF-8"><div id="root"></div><script type="module" src="./.generated-probe.tsx"></script></html>')
  await build({ root: web, configFile: path.join(web, 'vite.config.ts'), logLevel: 'warn', build: { outDir: dist, emptyOutDir: true,
    rollupOptions: { input: { app: path.join(web, 'index.html'), benchmark: generated } } } })
  server = createServer(async (request, response) => {
    try {
      const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname)
      if (pathname.startsWith('/__fixture/')) { const bytes = assets.get(pathname.slice('/__fixture/'.length)); if (!bytes) throw new Error('missing synthetic asset'); response.end(bytes); return }
      const target = path.resolve(dist, `.${pathname === '/' ? '/index.html' : pathname}`)
      if (!target.startsWith(dist + path.sep)) throw new Error('invalid path')
      response.setHeader('Content-Type', target.endsWith('.html') ? 'text/html' : target.endsWith('.js') ? 'text/javascript' : target.endsWith('.css') ? 'text/css' : 'application/octet-stream')
      response.end(await readFile(target))
    } catch { response.statusCode = 404; response.end('Not found') }
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); origin = `http://127.0.0.1:${server.address().port}`; result.metadata.origin = origin
  for (const count of sizes) {
    if (mode === 'backup') await backupCase(count)
    else if (mode === 'performance') await performanceCase(count)
    else throw new Error(`Unknown mode: ${mode}`)
  }
  result.metadata.completedAt = new Date().toISOString(); await save(); log(`RESULT ${output}`)
} finally {
  for (const context of contexts) await context.close().catch(() => {})
  if (server) await new Promise(resolve => server.close(resolve))
  await rm(generated, { force: true }); await rm(generatedProbe, { force: true })
}
