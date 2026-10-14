import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { DEFAULT_SETTINGS, db, loadSettings, saveSettings } from '../db/db'
import {
  clearAllData,
  buildDataBackupBlob,
  getArchiveStatus,
  getReviewNotes,
  importBackup,
  mimeTypeForFile,
  persistImportResults,
  persistLegacyImport,
  purgeDemoRows,
  readSnapshot,
  saveOriginalFile,
  setReviewNote,
  updateTransaction,
  updateTransactions,
  validateBackup,
  type ArchiveStatus,
  type Snapshot,
} from '../db/repository'
import { getDemoSnapshot } from '../demo/demoStore'
import { buildFullBackupZip, restoreFullBackupZip } from '../backup/archive'
import {
  hashLegacyFile,
  planLegacyImport,
  previewLegacyWorkbook,
  type LegacyExisting,
} from '../importers/legacyImport'
import type { LegacyPreview } from '../importers/types'
import { ingestParsedStatement, failedImportRecord, unsupportedRecord, type IngestResult } from '../core/ingest'
import { buildSourceDocument, sha256Hex } from '../parsers/extract'
import { detectParser, parseDocument, UnsupportedFileError } from '../parsers/registry'
import type { AppSettings, ImportRecord, Statement, Transaction } from '../core/types'
import { triggerDownload } from '../export/tabular'
import { downloadLedgerArchive, ledgerArchiveFileName } from '../export/ledgerArchive'
import { readJsonBackup } from '../backup/json'

export interface ImportProgress {
  fileName: string
  index: number
  total: number
  phase: string
}

export interface AppState extends Snapshot {
  ready: boolean
  settings: AppSettings
  notes: Record<string, string>
  progress: ImportProgress | null
  /** True when Demo Mode is on: real rows are hidden and imports are blocked. */
  demoMode: boolean
}

interface AppApi {
  state: AppState
  refresh: () => Promise<void>
  setSettings: (patch: Partial<AppSettings>) => Promise<void>
  importFiles: (files: File[]) => Promise<ImportRecord[]>
  previewLegacyImport: (file: File) => Promise<LegacyPreview>
  confirmLegacyImport: (preview: LegacyPreview) => Promise<ImportRecord>
  loadDemoData: () => Promise<void>
  updateTransaction: (patch: Partial<Transaction> & { id: string }) => Promise<void>
  saveNote: (transactionId: string, note: string) => Promise<void>
  backup: () => Promise<void>
  backupData: () => Promise<void>
  backupFull: () => Promise<{ warning: string | null }>
  exportLedgerXlsx: () => Promise<void>
  restore: (file: File) => Promise<{ ok: boolean; message: string }>
  archiveStatus: () => Promise<ArchiveStatus>
  clearData: (includeDemo: boolean) => Promise<void>
  visibleStatements: Statement[]
  visibleTransactions: Transaction[]
  visibleImports: ImportRecord[]
}

const AppContext = createContext<AppApi | null>(null)

const EMPTY: Snapshot = { statements: [], transactions: [], imports: [] }

interface ImportBatchResult extends IngestResult {
  evidence?: { buffer: ArrayBuffer; fileHash: string; fileName: string; mimeType: string }
}

export function AppProvider({ children }: { children: ReactNode }) {
  const [snapshot, setSnapshot] = useState<Snapshot>(EMPTY)
  const [settings, setSettingsState] = useState<AppSettings>(DEFAULT_SETTINGS)
  const [notes, setNotes] = useState<Record<string, string>>({})
  const [ready, setReady] = useState(false)
  const [progress, setProgress] = useState<ImportProgress | null>(null)
  const initialised = useRef(false)

  const refresh = useCallback(async () => {
    const [next, nextNotes, nextSettings] = await Promise.all([readSnapshot(), getReviewNotes(), loadSettings()])
    setSnapshot(next)
    setNotes(nextNotes)
    setSettingsState(nextSettings)
  }, [])

  useEffect(() => {
    if (initialised.current) return
    initialised.current = true
    void (async () => {
      // Migration: demo rows must never live in the production tables. Purge
      // any fictional rows written by older versions; real rows are untouched.
      await purgeDemoRows()
      await refresh()
      const existing = await db.imports.count()
      // A first visit lands in Demo Mode so every page has something to show.
      // Demo data is served from memory (see getDemoSnapshot), never written
      // to IndexedDB.
      if (existing === 0) {
        await saveSettings({ ...DEFAULT_SETTINGS, demoMode: true })
      }
      await refresh()
      setReady(true)
    })()
  }, [refresh])

  const setSettings = useCallback(
    async (patch: Partial<AppSettings>) => {
      const next = { ...settings, ...patch }
      setSettingsState(next)
      await saveSettings(next)
    },
    [settings],
  )

  const importFiles = useCallback(
    async (files: File[]): Promise<ImportRecord[]> => {
      if (settings.demoMode) {
        throw new Error('演示模式下无法导入真实账单，请先在设置中关闭演示模式。')
      }
      const results: ImportBatchResult[] = []
      let current = await readSnapshot()

      for (const [index, file] of files.entries()) {
        setProgress({ fileName: file.name, index, total: files.length, phase: '读取文件' })
        const meta = { fileName: file.name, fileSize: file.size, sourceType: 'unknown' as const }
        let evidence: ImportBatchResult['evidence']
        try {
          const buffer = await readFileWithRetry(file)
          setProgress({ fileName: file.name, index, total: files.length, phase: '计算 SHA-256' })
          const fileHash = await sha256Hex(buffer)
          // Bind evidence before parsing: extraction failures must retain the
          // same bytes that were hashed, without a second, potentially different read.
          evidence = { buffer: buffer.slice(0), fileHash, fileName: file.name, mimeType: file.type || mimeTypeForFile(file.name) }
          setProgress({ fileName: file.name, index, total: files.length, phase: '解析内容' })
          const doc = await buildSourceDocument({ fileName: file.name, buffer, fileHash })
          const match = detectParser(doc)
          if (!match) {
            const record = unsupportedRecord(
              { ...meta, fileHash, sourceType: doc.sourceType },
              `无法识别 ${file.name} 的银行与账单格式，未识别的文件不会被当作成功导入。`,
            )
            results.push({
              record,
              statement: null,
              transactions: [],
              inserted: [],
              skippedDuplicates: [],
              evidence,
            })
            continue
          }
          setProgress({ fileName: file.name, index, total: files.length, phase: '解析账单' })
          const parsed = parseDocument(doc, match.parser)
          const result = ingestParsedStatement(
            parsed,
            { ...meta, fileHash, sourceType: doc.sourceType },
            { statements: current.statements, transactions: current.transactions, imports: current.imports },
          )
          results.push({ ...result, evidence })
          current = {
            statements: current.statements.filter((s) => s.id !== result.statement?.id).concat(result.statement ?? []),
            transactions: current.transactions.filter((t) => t.statementId !== result.statement?.id).concat(result.transactions),
            imports: current.imports.filter((i) => i.id !== result.record.id).concat(result.record),
          }
        } catch (error) {
          const message = describeError(error)
          const fileHash = evidence?.fileHash ?? `unavailable-${crypto.randomUUID()}`
          results.push({
            record: failedImportRecord({ ...meta, fileHash }, message),
            statement: null,
            transactions: [],
            inserted: [],
            skippedDuplicates: [],
            evidence,
          })
        }
      }

      setProgress(null)
      await persistImportResults(results)
      // Archive raw evidence keyed by hash. Best-effort: never fails the import.
      for (const result of results) {
        const raw = result.evidence
        let retained = false
        if (raw) try {
          await saveOriginalFile({
            fileHash: raw.fileHash,
            fileName: raw.fileName,
            mimeType: raw.mimeType,
            data: raw.buffer.slice(0),
            importId: result.record.id,
            parserId: result.record.parserId,
          })
          retained = true
        } catch {
          // IndexedDB quota or private-mode limits must not break the import itself.
        }
        if (!retained) {
          result.record = { ...result.record, message: `${result.record.message}，原始文件未保留，可稍后重新导入。` }
          // The manifest also derives missing evidence from the attachment table,
          // even if quota prevents this optional warning from being persisted.
          try { await db.imports.put(result.record) } catch { /* Evidence remains missing. */ }
        }
      }
      await refresh()
      return results.map((result) => result.record)
    },
    [refresh, settings.demoMode],
  )

  const loadDemoData = useCallback(async () => {
    // Demo data lives in memory only: drop any legacy fictional rows, warm
    // the cache and reload the real snapshot. Nothing demo is ever written
    // to the production tables.
    await purgeDemoRows()
    getDemoSnapshot()
    await refresh()
  }, [refresh])

  /**
   * Legacy history import, kept strictly separate from bank-statement imports.
   * Preview is read-only; the confirm step writes one atomic transaction.
   */
  const previewLegacyImport = useCallback(
    async (file: File): Promise<LegacyPreview> => {
      if (settings.demoMode) {
        throw new Error('演示模式下无法导入历史数据，请先在设置中关闭演示模式。')
      }
      setProgress({ fileName: file.name, index: 0, total: 1, phase: '读取历史数据' })
      try {
        const { buffer, fileHash } = await hashLegacyFile(file)
        setProgress({ fileName: file.name, index: 0, total: 1, phase: '生成预览' })
        const snapshot = await readSnapshot()
        const existing: LegacyExisting = {
          imports: snapshot.imports,
          statements: snapshot.statements,
          transactions: snapshot.transactions,
        }
        return await previewLegacyWorkbook(
          buffer,
          { fileName: file.name, fileSize: file.size, fileHash },
          existing,
        )
      } finally {
        setProgress(null)
      }
    },
    [settings.demoMode],
  )

  const confirmLegacyImport = useCallback(
    async (preview: LegacyPreview): Promise<ImportRecord> => {
      if (settings.demoMode) {
        throw new Error('演示模式下无法导入历史数据，请先在设置中关闭演示模式。')
      }
      setProgress({ fileName: preview.meta.fileName, index: 0, total: 1, phase: '写入历史数据' })
      try {
        const snapshot = await readSnapshot()
        const plan = planLegacyImport(preview, {
          imports: snapshot.imports,
          statements: snapshot.statements,
          transactions: snapshot.transactions,
        })
        await persistLegacyImport(plan)
        await refresh()
        return plan.record
      } finally {
        setProgress(null)
      }
    },
    [refresh, settings.demoMode],
  )

  const patchTransaction = useCallback(
    async (patch: Partial<Transaction> & { id: string }) => {
      const current = snapshot.transactions.find((tx) => tx.id === patch.id)
      if (!current) return
      await updateTransaction({ ...current, ...patch })
      await refresh()
    },
    [refresh, snapshot.transactions],
  )

  const saveNote = useCallback(
    async (transactionId: string, note: string) => {
      await setReviewNote(transactionId, note)
      setNotes(await getReviewNotes())
    },
    [],
  )

  const backupData = useCallback(async () => {
    triggerDownload(
      await buildDataBackupBlob(),
      `credit-card-data-${new Date().toISOString().slice(0, 10)}.json`,
    )
  }, [])

  const backup = useCallback(async () => {
    await backupData()
  }, [backupData])

  const backupFull = useCallback(async (): Promise<{ warning: string | null }> => {
    const { blob, warning } = await buildFullBackupZip()
    triggerDownload(blob, `credit-card-full-backup-${new Date().toISOString().slice(0, 10)}.zip`)
    return { warning }
  }, [])

  const archiveStatus = useCallback(async (): Promise<ArchiveStatus> => getArchiveStatus(), [])

  const restore = useCallback(
    async (file: File) => {
      try {
        if (file.name.toLowerCase().endsWith('.zip')) {
          const result = await restoreFullBackupZip(file)
          await refresh()
          const base = `已恢复 ${result.transactions} 笔交易、${result.statements} 份账单、${result.files} 个原始文件。`
          return { ok: true, message: result.warning ? `${base}${result.warning}。` : base }
        }
        const payload = await readJsonBackup(file)
        if (!validateBackup(payload)) return { ok: false, message: '文件格式不正确，不是本应用导出的备份。' }
        await importBackup(payload)
        await refresh()
        return { ok: true, message: `已恢复 ${payload.transactions.length} 笔交易、${payload.statements.length} 份账单。` }
      } catch (error) {
        return { ok: false, message: `恢复失败：${describeError(error)}` }
      }
    },
    [refresh],
  )

  const clearData = useCallback(
    async (includeDemo: boolean) => {
      await clearAllData({ includeDemo })
      await refresh()
    },
    [refresh],
  )

  // Demo Mode is a view switch, not a second database: the fictional rows
  // come from an in-memory snapshot while `snapshot` always holds the real
  // IndexedDB content. Production pages keep filtering `!isDemo` so stray
  // legacy rows can never leak in before the next purge.
  const demoSnapshot = useMemo(() => (settings.demoMode ? getDemoSnapshot() : EMPTY), [settings.demoMode])

  const visibleStatements = useMemo(
    () => (settings.demoMode ? demoSnapshot.statements : snapshot.statements.filter((row) => !row.isDemo)),
    [settings.demoMode, snapshot.statements, demoSnapshot],
  )
  const visibleTransactions = useMemo(
    () => (settings.demoMode ? demoSnapshot.transactions : snapshot.transactions.filter((row) => !row.isDemo)),
    [settings.demoMode, snapshot.transactions, demoSnapshot],
  )
  const visibleImports = useMemo(
    () => (settings.demoMode ? demoSnapshot.imports : snapshot.imports.filter((row) => !row.isDemo)),
    [settings.demoMode, snapshot.imports, demoSnapshot],
  )

  /**
   * Human-readable XLSX archive of the currently visible ledger.
   * Unlike JSON backup, this file cannot restore the app: sheet 1 (交易明细)
   * keeps exact stored currencies and minor-unit amounts for independent
   * viewing in Excel / LibreOffice, while sheet 2 (Technical Metadata) keeps
   * exact stored IDs, fingerprints and occurrences. No conversion or
   * recalculation.
   */
  const exportLedgerXlsx = useCallback(async (): Promise<void> => {
    const transactions = settings.demoMode ? demoSnapshot.transactions : snapshot.transactions.filter((row) => !row.isDemo)
    const statements = settings.demoMode ? demoSnapshot.statements : snapshot.statements.filter((row) => !row.isDemo)
    await downloadLedgerArchive(ledgerArchiveFileName(), transactions, statements)
  }, [settings.demoMode, snapshot.transactions, snapshot.statements, demoSnapshot])

  const api = useMemo<AppApi>(
    () => ({
      state: { ...snapshot, ready, settings, notes, progress, demoMode: settings.demoMode },
      refresh,
      setSettings,
      importFiles,
      previewLegacyImport,
      confirmLegacyImport,
      loadDemoData,
      updateTransaction: patchTransaction,
      saveNote,
      backup,
      backupData,
      backupFull,
      exportLedgerXlsx,
      restore,
      archiveStatus,
      clearData,
      visibleStatements,
      visibleTransactions,
      visibleImports,
    }),
    [
      snapshot,
      ready,
      settings,
      notes,
      progress,
      refresh,
      setSettings,
      importFiles,
      previewLegacyImport,
      confirmLegacyImport,
      loadDemoData,
      patchTransaction,
      saveNote,
      backup,
      backupData,
      backupFull,
      exportLedgerXlsx,
      restore,
      archiveStatus,
      clearData,
      visibleStatements,
      visibleTransactions,
      visibleImports,
    ],
  )

  return <AppContext.Provider value={api}>{children}</AppContext.Provider>
}

async function readFileWithRetry(file: File): Promise<ArrayBuffer> {
  try {
    return await file.arrayBuffer()
  } catch {
    return file.arrayBuffer()
  }
}

function describeError(error: unknown): string {
  if (error instanceof UnsupportedFileError) return error.message
  if (error instanceof Error) return error.message
  return '未知错误'
}

export function useApp(): AppApi {
  const context = useContext(AppContext)
  if (!context) throw new Error('useApp must be used inside <AppProvider>')
  return context
}

export { updateTransactions }
