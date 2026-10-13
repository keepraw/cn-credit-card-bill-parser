import JSZip from 'jszip'
import { sha256Hex } from '../parsers/extract'
import {
  buildManifest,
  exportDataBackup,
  getAttachment,
  importBackup,
  saveOriginalFile,
  validateBackup,
  validateManifest,
  type ArchiveManifest,
  type BackupPayload,
} from '../db/repository'
import { db } from '../db/db'
import { MAX_EXPANDED_BYTES, MAX_ENTRY_BYTES, MAX_JSON_BYTES, readArchiveBytes, readZipEntry, validateZipDirectory } from './zipSafety'

export const FULL_BACKUP_VERSION = 1 as const
export const DATABASE_JSON = 'database.json'
export const MANIFEST_JSON = 'manifest.json'
export const ORIGINAL_FILES_DIR = 'original-files'

/** `sha256-originalname`, with path separators stripped so ZIP entries stay flat. */
export function archiveFileName(sha256: string, filename: string): string {
  const safe = filename.replace(/[\\/]/g, '_').replace(/[^a-zA-Z0-9.\-_一-鿿]/g, '_').slice(-80) || 'file'
  return `${sha256}-${safe}`
}

export function parseArchiveFileName(entry: string): string | null {
  const match = entry.match(/^([0-9a-f]{64})-/i)
  return match?.[1]?.toLowerCase() ?? null
}

export interface FullBackupPreview {
  manifest: ArchiveManifest
  database: BackupPayload
  archivedCount: number
  missingCount: number
  warning: string | null
}

export function describeArchiveGap(missingCount: number): string | null {
  if (missingCount <= 0) return null
  return `${missingCount} 个历史账单没有原始文件，仅导出交易数据`
}

/** Build the full-archive ZIP: database.json + manifest.json + available originals. */
export async function buildFullBackupZip(): Promise<{ blob: Blob; manifest: ArchiveManifest; warning: string | null }> {
  const [database, manifest] = await Promise.all([exportDataBackup(), buildManifest()])
  const zip = new JSZip()
  zip.file(DATABASE_JSON, JSON.stringify(database, null, 2))
  zip.file(MANIFEST_JSON, JSON.stringify(manifest, null, 2))
  const folder = zip.folder(ORIGINAL_FILES_DIR)
  if (!folder) throw new Error('无法创建备份压缩包')

  let archivedCount = 0
  for (const entry of manifest.files) {
    if (entry.storage !== 'indexeddb') continue
    const attachment = await getAttachment(entry.sha256)
    if (!attachment) continue
    folder.file(archiveFileName(entry.sha256, entry.filename), new Uint8Array(attachment.data))
    archivedCount += 1
  }

  const missingCount = manifest.files.length - archivedCount
  const blob = await zip.generateAsync({ type: 'blob', compression: 'STORE' })
  return { blob, manifest, warning: describeArchiveGap(missingCount) }
}

function isSha256Hex(value: string): boolean {
  return /^[0-9a-f]{64}$/i.test(value)
}

async function verifyBytesHash(data: ArrayBuffer, expectedHex: string): Promise<void> {
  const actual = await sha256Hex(data)
  if (actual.toLowerCase() !== expectedHex.toLowerCase()) {
    throw new Error(`原始文件校验失败（${expectedHex.slice(0, 12)}…）：SHA-256 不一致，拒绝恢复`)
  }
}

interface VerifiedOriginal {
  sha256: string
  filename: string
  data: ArrayBuffer
  importId: string
  parserId: string
}

/** One validation path for preview and restore; no persistent operations. */
async function prepareFullBackup(file: Blob): Promise<FullBackupPreview & { originals: VerifiedOriginal[] }> {
  const archiveBytes = await readArchiveBytes(file)
  validateZipDirectory(archiveBytes)
  const zip = await JSZip.loadAsync(archiveBytes)
  const databaseFile = zip.file(DATABASE_JSON)
  const manifestFile = zip.file(MANIFEST_JSON)
  if (!databaseFile || !manifestFile) throw new Error('压缩包缺少 database.json 或 manifest.json')
  const budget = { remaining: MAX_EXPANDED_BYTES }
  const decode = (bytes: ArrayBuffer) => JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown
  const database = decode(await readZipEntry(databaseFile, MAX_JSON_BYTES, budget))
  const manifest = decode(await readZipEntry(manifestFile, MAX_JSON_BYTES, budget))
  if (!validateBackup(database)) throw new Error('database.json 包含无效记录')
  if (!validateManifest(manifest)) throw new Error('manifest.json 版本不受支持或格式错误')
  const imports = new Map(database.imports.map((row) => [row.id, row]))
  if (manifest.files.length !== imports.size) throw new Error('原始文件清单与导入记录不一致')

  const prefix = `${ORIGINAL_FILES_DIR}/`
  const byHash = new Map<string, string[]>()
  for (const [path, entry] of Object.entries(zip.files)) {
    if (entry.unsafeOriginalName && entry.unsafeOriginalName !== path) throw new Error('ZIP 包含不安全路径')
    if (entry.dir) continue
    if (path === DATABASE_JSON || path === MANIFEST_JSON) continue
    if (!path.startsWith(prefix) || path.slice(prefix.length).includes('/')) throw new Error('ZIP 包含清单外文件')
    const hash = parseArchiveFileName(path.slice(prefix.length))
    if (hash) {
      const paths = byHash.get(hash) ?? []
      paths.push(path)
      byHash.set(hash, paths)
    }
  }
  const consumed = new Set<string>([DATABASE_JSON, MANIFEST_JSON])
  const cached = new Map<string, ArrayBuffer>()
  const originals: VerifiedOriginal[] = []
  for (const entry of manifest.files) {
    const record = imports.get(entry.importId)
    if (!record || record.fileHash !== entry.sha256 || record.fileName !== entry.filename ||
      record.parserId !== entry.parserId || record.importedAt !== entry.importedAt) throw new Error('原始文件清单与导入记录不一致')
    if (entry.storage !== 'indexeddb') continue
    const realHash = isSha256Hex(entry.sha256)
    // Version-1 demo archives used synthetic hashes. Preserve that explicit,
    // fictional compatibility case; real evidence must always be verifiable.
    if (!realHash && !(record.isDemo && entry.sha256.startsWith('demo-'))) throw new Error('原始文件缺少有效 SHA-256')
    let path = `${prefix}${archiveFileName(entry.sha256, entry.filename)}`
    let zipEntry = zip.file(path)
    if (!zipEntry) {
      const candidates = byHash.get(entry.sha256.toLowerCase()) ?? []
      if (candidates.length === 1) { path = candidates[0]!; zipEntry = zip.file(path) }
    }
    if (!zipEntry) throw new Error(`压缩包缺少原始文件：${entry.filename}`)
    consumed.add(path)
    let data = cached.get(path)
    if (!data) {
      data = await readZipEntry(zipEntry, MAX_ENTRY_BYTES, budget)
      if (realHash) await verifyBytesHash(data, entry.sha256)
      cached.set(path, data)
    }
    originals.push({ sha256: entry.sha256, filename: entry.filename, data, importId: entry.importId, parserId: entry.parserId })
  }
  if (Object.entries(zip.files).some(([path, entry]) => !entry.dir && !consumed.has(path))) throw new Error('ZIP 包含清单外原始文件')
  const archivedCount = originals.length
  const missingCount = manifest.files.length - archivedCount
  return { manifest, database, originals, archivedCount, missingCount, warning: describeArchiveGap(missingCount) }
}

/** Records, settings and evidence commit together or roll back together. */
export async function restoreFullBackupZip(file: Blob): Promise<{ transactions: number; statements: number; files: number; warning: string | null }> {
  const { database, originals, warning } = await prepareFullBackup(file)
  let files = 0
  await db.transaction('rw', [db.statements, db.transactions, db.imports, db.settings, db.attachments], async () => {
    await importBackup(database)
    for (const item of originals) {
      const existing = await db.attachments.get(item.sha256)
      if (existing) {
        const current = new Uint8Array(existing.data)
        const incoming = new Uint8Array(item.data)
        if (current.length !== incoming.length || current.some((byte, index) => byte !== incoming[index])) throw new Error('已有原始文件内容冲突，拒绝恢复')
        continue
      }
      await saveOriginalFile({ fileHash: item.sha256, fileName: item.filename, data: item.data, importId: item.importId, parserId: item.parserId })
      files += 1
    }
  })
  return { transactions: database.transactions.length, statements: database.statements.length, files, warning }
}

/** Preview verifies the same records, manifest and evidence as an actual restore. */
export async function previewFullBackupZip(file: Blob): Promise<FullBackupPreview> {
  const { originals: _originals, ...preview } = await prepareFullBackup(file)
  return preview
}
