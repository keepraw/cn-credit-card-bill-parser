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

async function verifyBytesHash(bytes: Uint8Array, expectedHex: string): Promise<void> {
  // Demo and legacy rows use synthetic `demo-…` fingerprints instead of a real
  // SHA-256. Only enforce the check when the manifest actually carries a hash.
  if (!isSha256Hex(expectedHex)) return
  const copy = new Uint8Array(bytes.byteLength)
  copy.set(bytes)
  const actual = await sha256Hex(copy.buffer as ArrayBuffer)
  if (actual.toLowerCase() !== expectedHex.toLowerCase()) {
    throw new Error(`原始文件校验失败（${expectedHex.slice(0, 12)}…）：SHA-256 不一致，拒绝恢复`)
  }
}

/**
 * Restore a full-archive ZIP. Never overwrites blindly:
 * transactions/statements/imports merge by primary key (idempotent),
 * attachments are skipped when the hash already exists.
 */
export async function restoreFullBackupZip(file: Blob): Promise<{ transactions: number; statements: number; files: number }> {
  const zip = await JSZip.loadAsync(file)
  const databaseFile = zip.file(DATABASE_JSON)
  const manifestFile = zip.file(MANIFEST_JSON)
  if (!databaseFile || !manifestFile) throw new Error('压缩包缺少 database.json 或 manifest.json')

  const database: unknown = JSON.parse(await databaseFile.async('string'))
  const manifest: unknown = JSON.parse(await manifestFile.async('string'))
  if (!validateBackup(database)) throw new Error('database.json 不是本应用导出的备份')
  if (!validateManifest(manifest)) throw new Error('manifest.json 版本不受支持或格式错误')
  if (manifest.version !== FULL_BACKUP_VERSION) throw new Error(`不支持的 manifest 版本：${manifest.version}`)

  // Verify every archived file before touching the database.
  const verified: Array<{ sha256: string; filename: string; data: ArrayBuffer; importId: string; parserId: string }> = []
  const folderPrefix = `${ORIGINAL_FILES_DIR}/`
  for (const entry of manifest.files) {
    if (entry.storage === 'missing' || entry.storage === 'external') continue
    const zipPath = `${folderPrefix}${archiveFileName(entry.sha256, entry.filename)}`
    let zipEntry = zip.file(zipPath)
    if (!zipEntry) {
      // Fall back to hash-prefix match for archives written with different sanitising.
      const candidates = Object.keys(zip.files).filter(
        (path) => path.startsWith(folderPrefix) && parseArchiveFileName(path.slice(folderPrefix.length)) === entry.sha256.toLowerCase(),
      )
      if (candidates.length === 1) zipEntry = zip.file(candidates[0]!)
    }
    if (!zipEntry) throw new Error(`压缩包缺少原始文件：${entry.filename}`)
    const bytes = await zipEntry.async('uint8array')
    await verifyBytesHash(bytes, entry.sha256)
    const data = new Uint8Array(bytes.byteLength) as Uint8Array
    data.set(bytes)
    verified.push({ sha256: entry.sha256, filename: entry.filename, data: data.buffer as ArrayBuffer, importId: entry.importId, parserId: entry.parserId })
  }

  await importBackup(database)

  let restoredFiles = 0
  await db.transaction('rw', db.attachments, async () => {
    for (const item of verified) {
      const existing = await db.attachments.get(item.sha256)
      if (existing) continue
      await saveOriginalFile({
        fileHash: item.sha256,
        fileName: item.filename,
        data: item.data,
        importId: item.importId,
        parserId: item.parserId,
      })
      restoredFiles += 1
    }
  })

  return { transactions: database.transactions.length, statements: database.statements.length, files: restoredFiles }
}

/** Peek at a ZIP without restoring: used for the pre-restore confirmation message. */
export async function previewFullBackupZip(file: Blob): Promise<FullBackupPreview> {
  const zip = await JSZip.loadAsync(file)
  const databaseFile = zip.file(DATABASE_JSON)
  const manifestFile = zip.file(MANIFEST_JSON)
  if (!databaseFile || !manifestFile) throw new Error('压缩包缺少 database.json 或 manifest.json')
  const database: unknown = JSON.parse(await databaseFile.async('string'))
  const manifest: unknown = JSON.parse(await manifestFile.async('string'))
  if (!validateBackup(database)) throw new Error('database.json 不是本应用导出的备份')
  if (!validateManifest(manifest)) throw new Error('manifest.json 版本不受支持或格式错误')
  const archivedCount = manifest.files.filter((entry) => entry.storage === 'indexeddb').length
  const missingCount = manifest.files.length - archivedCount
  return { manifest, database, archivedCount, missingCount, warning: describeArchiveGap(missingCount) }
}
