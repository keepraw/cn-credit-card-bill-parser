/** Read-only local audit of a known historical XLSX against a version-1 JSON backup. */
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { basename, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'

const args = process.argv.slice(2)
const legacyPath = args[args.indexOf('--legacy') + 1]
const backupPath = args[args.indexOf('--backup') + 1]
if (!args.includes('--legacy') || !args.includes('--backup') || !legacyPath || !backupPath) {
  throw new Error('usage: npm run migration:audit -- --legacy <history.xlsx> --backup <credit-card-data.json>')
}
const root = fileURLToPath(new URL('../', import.meta.url))
const server = await createServer({
  root, configFile: false, logLevel: 'silent', optimizeDeps: { noDiscovery: true, include: [] },
  server: { middlewareMode: true, watch: null }, appType: 'custom',
})
try {
  const { validateBackup } = await server.ssrLoadModule('/src/backup/validation.ts')
  const { previewLegacyWorkbook } = await server.ssrLoadModule('/src/importers/legacyImport.ts')
  const backup = JSON.parse(await readFile(resolve(backupPath), 'utf8'))
  if (!validateBackup(backup)) throw new Error('invalid version-1 backup; audit refused')
  const bytes = await readFile(resolve(legacyPath))
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
  const preview = await previewLegacyWorkbook(buffer, {
    fileName: basename(legacyPath), fileSize: bytes.length, fileHash: createHash('sha256').update(bytes).digest('hex'),
  }, backup)
  // No descriptions, amounts, dates, original filenames or backup contents are logged.
  process.stdout.write(JSON.stringify({
    formatId: preview.stats.formatId, totalRows: preview.stats.totalRows, validRows: preview.stats.validRows,
    excludedRows: preview.stats.anomalyRows, excludedByKind: preview.stats.anomaliesByKind,
    dateReviewRows: preview.reviewIssues?.length ?? 0,
    duplicateFile: preview.stats.duplicateFile, wouldSkipExactOccurrences: preview.stats.alreadyStored,
    audit: preview.migrationAudit,
  }, null, 2) + '\n')
} finally {
  await server.close()
}
