import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const result = JSON.parse(await readFile(process.argv[2] ?? path.join(root, 'docs/benchmarks/storage-results.json'), 'utf8'))
const median = values => { const sorted = [...values].sort((a, b) => a - b); return sorted.length % 2 ? sorted[Math.floor(sorted.length / 2)] : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2 }
const mib = value => (value / 1048576).toFixed(3)
const range = values => `${median(values).toFixed(1)} [${Math.min(...values).toFixed(1)}, ${Math.max(...values).toFixed(1)}]`
const primary = result.runs.filter(run => run.format === 'python' && !run.options.longRaw)
const first = count => primary.find(run => run.count === count && run.replicate === 0)
const table = (headers, rows) => {
  process.stdout.write(`\n| ${headers.join(' | ')} |\n| ${headers.map(() => '---').join(' | ')} |\n${rows.map(row => `| ${row.join(' | ')} |`).join('\n')}\n`)
}
table(['Transactions', 'Records JSON Size (MiB)', 'Browser Estimated Usage (MiB)', 'Baseline-subtracted (MiB)', 'Estimated Bytes/Transaction'], [0, 18000, 36000, 100000].filter(count => first(count)).map(count => {
  const runs = primary.filter(run => run.count === count), run = first(count)
  // Compare the same checkpoint for every scale: after the normal import and
  // AppStore refresh, before auxiliary scans, reopen, edits, and benchmarks.
  const usage = median(runs.map(run => run.initialUsage.usage)), delta = median(runs.map(run => run.initialUsage.usage - run.baseline.usage))
  return [count.toLocaleString('en-US'), mib(run.metrics.totalRecordsJsonBytes), mib(usage), count ? mib(delta) : '0', count ? (delta / count).toFixed(1) : '—']
}))
table(['Scale', 'Table', 'Records', 'UTF-8 JSON bytes', 'Binary bytes'], [0, 18000, 36000, 100000].filter(count => first(count)).flatMap(count => Object.entries(first(count).metrics.tables).map(([name, value]) => [count, name, value.count, value.jsonBytes, value.binaryBytes])))
for (const count of [18000, 100000].filter(count => first(count))) {
  const run = first(count), samples = run.performance
  table([`Metric (${count})`, 'Median [min, max] ms'], [
    ['Normal AppStore XLSX import (3 fresh profiles)', range(primary.filter(r => r.count === count).map(r => r.import.totalMs))],
    ['XLSX/hash/preview phase', range(primary.filter(r => r.count === count).map(r => r.import.previewMs))],
    ['Confirm/plan/persistence/refresh phase', range(primary.filter(r => r.count === count).map(r => r.import.confirmMs))],
    ...['hashMs', 'previewMs', 'planMs'].map(key => [key, range(run.components.map(sample => sample[key]))]),
    ['persistLegacyImport', range(run.persistenceMs)],
    ['database open only', range(run.databaseOpenMs)],
    ['actual application first ready', range(run.startups.map(sample => sample.firstReadyMs))],
    ...['readMs', 'filterAllMs', 'dateSortMs', 'filteredSearchMs', 'descriptionSortMs', 'backupReadMs', 'backupEncodeBlobMs', 'backupTotalMs', 'refreshResolvedMs', 'refreshCommitMs', 'refreshPaintMs'].map(key => [key, range(samples.map(sample => sample[key]))]),
    ...['searchMs', 'dateSortMs', 'descriptionSortMs'].map(key => [`UI ${key}`, range(run.ui.map(sample => sample[key]))]),
  ])
}
if (first(18000)) {
  const run = first(18000)
  table(['Field (18,000)', 'Raw string UTF-8 bytes', 'JSON value bytes', 'JSON marginal bytes', 'Unique values'], Object.entries(run.metrics.fields).sort((a, b) => b[1].marginalBytes - a[1].marginalBytes).map(([key, value]) => [key, value.utf8TextBytes, value.jsonValueBytes, value.marginalBytes, value.uniqueValues]))
  table(['Serialization-only counterfactual', 'Saved bytes', 'Saved MiB'], Object.entries(run.metrics.counterfactuals).map(([key, value]) => [key, value.savedBytes, mib(value.savedBytes)]))
  table(['18,000 format', 'Transaction JSON bytes/object', 'Records JSON MiB', 'Estimated usage MiB', 'Statements'], result.runs.filter(run => run.count === 18000 && run.replicate === 0).map(run => [run.options.longRaw ? 'python / rawText x5' : run.format, (run.metrics.transactionObjectJsonBytes / 18000).toFixed(2), mib(run.metrics.totalRecordsJsonBytes), mib(run.initialUsage.usage), run.metrics.tables.statements.count]))
  if (run.lifecycle) table(['Lifecycle stage', 'Transactions', 'Imports', 'Review notes', 'Attachments', 'Usage MiB'], run.lifecycle.stages.map(stage => [stage.label, stage.counts.transactions, stage.counts.imports, stage.counts.reviewNotes, stage.counts.attachments, mib(stage.usage.usage)]))
}
if (result.controls.length) table(['Index control', 'Median quota increment MiB', 'Median disk file bytes', 'Median allocated bytes', 'Persistence median ms'], [true, false].map(indexed => {
  const rows = result.controls.filter(row => row.indexed === indexed)
  return [indexed ? 'all secondary indexes' : 'primary keys only', mib(median(rows.map(row => row.after.usage - row.baseline.usage))), median(rows.map(row => row.disk.fileBytes)), median(rows.map(row => row.disk.allocatedBytes)), median(rows.map(row => row.persistenceMs)).toFixed(1)]
}))
table(['Scale', 'Closed profile IndexedDB logical file bytes', 'Allocated bytes', 'Initial usage range (bytes)', 'Reopened usage range (bytes)'], [0, 18000, 36000, 100000].filter(count => first(count)).map(count => {
  const run = first(count), rows = primary.filter(run => run.count === count)
  return [count, run.initialDisk.fileBytes, run.initialDisk.allocatedBytes, `${Math.min(...rows.map(row => row.initialUsage.usage))} – ${Math.max(...rows.map(row => row.initialUsage.usage))}`, `${Math.min(...rows.map(row => row.reopenedUsage.usage))} – ${Math.max(...rows.map(row => row.reopenedUsage.usage))}`]
}))
const points = [0, 18000, 36000, 100000].filter(count => first(count)).map(count => ({ x: count, y: count === 0 ? 0 : median(primary.filter(run => run.count === count).map(run => run.initialUsage.usage - run.baseline.usage)) }))
const meanX = points.reduce((sum, point) => sum + point.x, 0) / points.length, meanY = points.reduce((sum, point) => sum + point.y, 0) / points.length
const slope = points.reduce((sum, point) => sum + (point.x - meanX) * (point.y - meanY), 0) / points.reduce((sum, point) => sum + (point.x - meanX) ** 2, 0)
const intercept = meanY - slope * meanX
const rSquared = 1 - points.reduce((sum, point) => sum + (point.y - slope * point.x - intercept) ** 2, 0) / points.reduce((sum, point) => sum + (point.y - meanY) ** 2, 0)
process.stdout.write(`\nLinear fit (descriptive, four sizes only): slope=${slope.toFixed(3)} bytes/transaction, intercept=${intercept.toFixed(1)} bytes, R²=${rSquared.toFixed(6)}\n`)
