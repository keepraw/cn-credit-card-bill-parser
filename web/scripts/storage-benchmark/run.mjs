import { build } from 'vite'
import { chromium } from '@playwright/test'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, writeFile, readFile, readdir, stat, rm } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { SEED, makeRows, makeWorkbook, expectedDistribution } from './fixture.mjs'

const directory = path.dirname(fileURLToPath(import.meta.url))
const web = path.resolve(directory, '../..')
const repo = path.resolve(web, '..')
const output = path.resolve(process.env.BENCH_OUTPUT ?? path.join(repo, 'docs/benchmarks/storage-results.json'))
const scratchRoot = path.resolve(process.env.BENCH_SCRATCH ?? '/workspace/scratch')
await mkdir(scratchRoot, { recursive: true })
const temporary = await mkdtemp(path.join(scratchRoot, 'keepraw-storage-'))
const generated = path.join(directory, '.generated.html')
const dist = path.join(temporary, 'dist')
const fixtures = new Map()
const quick = process.env.BENCH_QUICK === '1'
const repetitions = quick ? 1 : 3
const executablePath = process.env.CHROMIUM_PATH ?? (await stat('/usr/bin/chromium').catch(() => null) ? '/usr/bin/chromium' : chromium.executablePath())
const result = {
  metadata: { date: new Date().toISOString(), commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim(), seed: SEED,
    node: process.version, platform: os.platform(), cpus: os.cpus().length, cpu: os.cpus()[0].model, memoryBytes: os.totalmem(),
    profileFilesystem: execFileSync('df', ['-T', temporary], { encoding: 'utf8' }).trim(), productionBuild: true, strictModeHarness: false, repetitions, temporary },
  fixtures: {}, runs: [], controls: [],
}
const save = async () => { await mkdir(path.dirname(output), { recursive: true }); await writeFile(output, JSON.stringify(result, null, 2) + '\n') }
const log = message => process.stdout.write(`${new Date().toISOString()} ${message}\n`)
const hash = data => createHash('sha256').update(data).digest('hex')
async function prepare(count, format = 'python', options = {}) {
  const key = `${format}-${count}${options.variant ? '-variant' : ''}${options.longRaw ? '-long' : ''}.xlsx`
  if (!fixtures.has(key)) {
    const rows = makeRows(count)
    const bytes = makeWorkbook(rows, format, options)
    fixtures.set(key, bytes)
    result.fixtures[key] = { byteLength: bytes.length, sha256: hash(bytes), expected: expectedDistribution(rows), format, ...options }
    log(`fixture ${key}: ${bytes.length} bytes`)
  }
  return key
}
let server
const contexts = new Set()
async function launch(profile) {
  const context = await chromium.launchPersistentContext(profile, { executablePath, headless: true, locale: 'zh-CN', timezoneId: 'UTC',
    acceptDownloads: true, viewport: { width: 1440, height: 1000 }, args: ['--no-sandbox', '--disable-dev-shm-usage'] })
  contexts.add(context)
  context.on('close', () => contexts.delete(context))
  await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort())
  return context
}
let origin
async function call(page, method, ...args) {
  return page.evaluate(async ({ method, args }) => window.benchmark[method](...args), { method, args })
}
async function harness(context) {
  const page = context.pages()[0] ?? await context.newPage()
  page.setDefaultTimeout(120000)
  page.on('pageerror', error => log(`PAGE ERROR ${error.message}`))
  await page.goto(`${origin}/scripts/storage-benchmark/.generated.html#/transactions`)
  await page.waitForFunction(() => window.benchmark?.ready())
  await call(page, 'disableDemo')
  return page
}
async function disk(profile) {
  const root = path.join(profile, 'Default', 'IndexedDB'), files = []
  const walk = async directory => {
    for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
      const full = path.join(directory, entry.name)
      if (entry.isDirectory()) await walk(full)
      else { const info = await stat(full); files.push({ path: path.relative(root, full), bytes: info.size, allocatedBytes: info.blocks * 512 }) }
    }
  }
  await walk(root)
  return { fileBytes: files.reduce((sum, file) => sum + file.bytes, 0), allocatedBytes: files.reduce((sum, file) => sum + file.allocatedBytes, 0), files }
}
async function uiSamples(page) {
  const samples = []
  const measure = async (kind, action) => {
    const pending = page.evaluate(kind => new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { document.removeEventListener(kind, handler, true); reject(new Error(`UI event missing: ${kind}`)) }, 20000)
      const handler = () => { clearTimeout(timeout); const start = performance.now(); requestAnimationFrame(() => requestAnimationFrame(() => resolve(performance.now() - start))) }
      document.addEventListener(kind, handler, { once: true, capture: true })
    }), kind)
    await action()
    return pending
  }
  for (let i = 0; i < 5; i++) {
    const searchMs = await measure('input', () => page.getByTestId('transaction-search').fill('咖啡'))
    await page.getByTestId('transaction-search').fill('')
    const dateSortMs = await measure('click', () => page.locator('th.sortable').filter({ hasText: '交易日' }).click())
    const descriptionSortMs = await measure('click', () => page.locator('th.sortable').filter({ hasText: '交易描述' }).click())
    samples.push({ searchMs, dateSortMs, descriptionSortMs })
  }
  return samples
}
async function startups(context, count) {
  const samples = []
  for (let i = 0; i < 3; i++) {
    const page = await context.newPage()
    await page.addInitScript(count => {
      const observer = new MutationObserver(() => {
        const text = document.querySelector('.page-head p')?.textContent ?? ''
        if ((count === 0 && text.startsWith('共 ')) || (document.querySelector('[data-testid="transactions-table"]') && text.startsWith(`共 ${count} 笔`))) {
          window.firstReadyMs = performance.now(); window.firstReadyText = text; observer.disconnect()
        }
      })
      observer.observe(document, { childList: true, subtree: true, characterData: true })
    }, count)
    await page.goto(`${origin}/#/transactions`)
    await page.waitForFunction(() => window.firstReadyMs !== undefined, undefined, { timeout: 120000 })
    samples.push(await page.evaluate(() => ({ firstReadyMs: window.firstReadyMs, text: window.firstReadyText, navigation: performance.getEntriesByType('navigation')[0].toJSON() })))
    await page.close()
  }
  return samples
}
async function run(count, format, replicate, options = {}) {
  const key = count ? await prepare(count, format, options) : null
  const profile = path.join(temporary, `${format}-${count}-${replicate}${options.longRaw ? '-long' : ''}`)
  log(`START ${path.basename(profile)}`)
  let context = await launch(profile), page = await harness(context)
  const run = { count, format, replicate, options, path: 'AppStore XLSX preview + confirm + persistLegacyImport + refresh', baseline: await call(page, 'usage') }
  if (key) {
    run.import = await call(page, 'normalImport', key)
    if (await call(page, 'count') !== count) throw new Error(`Wrong transaction count for ${key}`)
  }
  run.initialUsage = await call(page, 'usage')
  if (replicate === 0) run.metrics = await call(page, 'metrics')
  await context.close()
  run.initialDisk = await disk(profile)
  context = await launch(profile); page = await harness(context)
  run.reopenedUsage = await call(page, 'usage')
  if (replicate === 0 && [0, 18000, 100000].includes(count) && format === 'python' && !options.longRaw) {
    run.databaseOpenMs = []
    for (let i = 0; i < 5; i++) run.databaseOpenMs.push(await call(page, 'openMs'))
    if (count) {
      run.performance = await call(page, 'performanceSamples', 5)
      run.ui = await uiSamples(page)
      run.backupRoundTrip = await call(page, 'backupRoundTrip')
      run.components = []
      for (let i = 0; i < repetitions; i++) run.components.push(await call(page, 'components', key))
    }
    run.startups = await startups(context, count)
    if (count === 18000) {
      run.lifecycle = await call(page, 'lifecycle', key, await prepare(count, format, { variant: true }))
      run.attachments = await call(page, 'attachmentExperiment', key)
    }
    if (count) {
      run.persistenceMs = []
      for (let i = 0; i < repetitions; i++) run.persistenceMs.push(await call(page, 'persistenceSample'))
    }
  }
  await context.close()
  run.finalDisk = await disk(profile)
  result.runs.push(run); await save()
  log(`DONE ${path.basename(profile)} usage=${run.reopenedUsage.usage} import=${run.import?.totalMs?.toFixed(1)}ms`)
}
async function control(indexed, replicate) {
  const profile = path.join(temporary, `index-control-${indexed}-${replicate}`)
  log(`START ${path.basename(profile)}`)
  const context = await launch(profile), page = await harness(context)
  const measurement = await call(page, 'scratch', await prepare(18000), indexed)
  await context.close()
  result.controls.push({ replicate, path: 'Direct native IndexedDB scratch database; identical importer-produced objects', ...measurement, disk: await disk(profile) })
  await save(); log(`DONE control indexed=${indexed} delta=${measurement.after.usage - measurement.baseline.usage}`)
}
try {
  await writeFile(generated, '<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"></head><body><div id="root"></div><script type="module" src="./browser.tsx"></script></body></html>')
  await build({ root: web, configFile: path.join(web, 'vite.config.ts'), logLevel: 'warn', build: { outDir: dist, emptyOutDir: true,
    rollupOptions: { input: { app: path.join(web, 'index.html'), benchmark: generated } } } })
  server = createServer(async (request, response) => {
    try {
      const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname)
      if (pathname.startsWith('/__fixture/')) {
        const bytes = fixtures.get(pathname.slice('/__fixture/'.length)); if (!bytes) throw new Error('missing fixture')
        response.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'); response.end(bytes); return
      }
      const target = path.resolve(dist, `.${pathname === '/' ? '/index.html' : pathname}`)
      if (!target.startsWith(dist + path.sep)) throw new Error('invalid path')
      response.setHeader('Content-Type', target.endsWith('.html') ? 'text/html' : target.endsWith('.js') ? 'text/javascript' : target.endsWith('.css') ? 'text/css' : 'application/octet-stream')
      response.end(await readFile(target))
    } catch { response.statusCode = 404; response.end('Not found') }
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  origin = `http://127.0.0.1:${server.address().port}`
  result.metadata.origin = origin
  const first = await launch(path.join(temporary, 'version'))
  result.metadata.chromium = first.browser().version(); await first.close()
  await run(0, 'python', 0)
  for (const count of quick ? [18000] : [18000, 36000, 100000]) {
    for (let replicate = 0; replicate < (count === 36000 ? 1 : repetitions); replicate++) await run(count, 'python', replicate)
  }
  for (const format of ['keepraw', 'unified']) await run(18000, format, 0)
  await run(18000, 'python', 0, { longRaw: true })
  for (let replicate = 0; replicate < repetitions; replicate++) for (const indexed of [true, false]) await control(indexed, replicate)
  await save(); log(`RESULTS ${output}`)
} finally {
  for (const context of contexts) await context.close().catch(() => {})
  if (server) await new Promise(resolve => server.close(resolve))
  await rm(generated, { force: true })
  // Profiles are retained for inspection and excluded from the repository.
}
