import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { buildDemoDataset } from '../demo/demoData'
import { DEFAULT_SETTINGS, db, loadSettings, saveSettings } from '../db/db'
import {
  clearAllData,
  clearDemoData,
  exportDataBackup,
  getArchiveStatus,
  getReviewNotes,
  importBackup,
  mimeTypeForFile,
  persistImportResults,
  readSnapshot,
  saveOriginalFile,
  setReviewNote,
  updateTransaction,
  updateTransactions,
  validateBackup,
  type ArchiveStatus,
  type Snapshot,
} from '../db/repository'
import { buildFullBackupZip, previewFullBackupZip, restoreFullBackupZip } from '../backup/archive'
import { ingestParsedStatement, failedImportRecord, unsupportedRecord, type IngestResult } from '../core/ingest'
import { buildSourceDocument, sha256Hex } from '../parsers/extract'
import { detectParser, parseDocument, UnsupportedFileError } from '../parsers/registry'
import type { AppSettings, ImportRecord, Statement, Transaction } from '../core/types'
import { triggerDownload } from '../export/tabular'

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
  loadDemoData: () => Promise<void>
  updateTransaction: (patch: Partial<Transaction> & { id: string }) => Promise<void>
  saveNote: (transactionId: string, note: string) => Promise<void>
  backup: () => Promise<void>
  backupData: () => Promise<void>
  backupFull: () => Promise<{ warning: string | null }>
  restore: (file: File) => Promise<{ ok: boolean; message: string }>
  archiveStatus: () => Promise<ArchiveStatus>
  clearData: (includeDemo: boolean) => Promise<void>
  visibleStatements: Statement[]
  visibleTransactions: Transaction[]
  visibleImports: ImportRecord[]
}

const AppContext = createContext<AppApi | null>(null)

const EMPTY: Snapshot = { statements: [], transactions: [], imports: [] }

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
      await refresh()
      const existing = await db.imports.count()
      // A first visit lands in Demo Mode so every page has something to show.
      if (existing === 0) {
        await persistImportResults(buildDemoDataset())
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
      const results: IngestResult[] = []
      // Raw bytes kept alongside each result so evidence can be archived.
      const evidence: Array<{ buffer: ArrayBuffer; fileName: string; mimeType: string }> = []
      let current = await readSnapshot()

      for (const [index, file] of files.entries()) {
        setProgress({ fileName: file.name, index, total: files.length, phase: '读取文件' })
        const meta = { fileName: file.name, fileSize: file.size, sourceType: 'unknown' as const }
        try {
          const buffer = await file.arrayBuffer()
          setProgress({ fileName: file.name, index, total: files.length, phase: '计算 SHA-256' })
          const fileHash = await sha256Hex(buffer)
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
            })
            evidence.push({ buffer: buffer.slice(0), fileName: file.name, mimeType: file.type || mimeTypeForFile(file.name) })
            continue
          }
          setProgress({ fileName: file.name, index, total: files.length, phase: '解析账单' })
          const parsed = parseDocument(doc, match.parser)
          const result = ingestParsedStatement(
            parsed,
            { ...meta, fileHash, sourceType: doc.sourceType },
            { statements: current.statements, transactions: current.transactions, imports: current.imports },
          )
          results.push(result)
          evidence.push({ buffer: buffer.slice(0), fileName: file.name, mimeType: file.type || mimeTypeForFile(file.name) })
          current = {
            statements: current.statements.filter((s) => s.id !== result.statement?.id).concat(result.statement ?? []),
            transactions: current.transactions.filter((t) => t.statementId !== result.statement?.id).concat(result.transactions),
            imports: current.imports.filter((i) => i.id !== result.record.id).concat(result.record),
          }
        } catch (error) {
          const message = describeError(error)
          const fileHash = await safeHash(file)
          results.push({
            record: failedImportRecord({ ...meta, fileHash }, message),
            statement: null,
            transactions: [],
            inserted: [],
            skippedDuplicates: [],
          })
          try {
            const retry = await file.arrayBuffer()
            if (fileHash !== 'unavailable') {
              evidence.push({ buffer: retry, fileName: file.name, mimeType: file.type || mimeTypeForFile(file.name) })
            }
          } catch {
            // Evidence is best-effort: a file we cannot re-read stays `missing`.
          }
        }
      }

      setProgress(null)
      await persistImportResults(results.filter((result) => result.statement !== null))
      await persistFailureRecords(results)
      // Archive raw evidence keyed by hash. Best-effort: never fails the import.
      for (const [i, result] of results.entries()) {
        const raw = evidence[i]
        if (!raw || result.record.fileHash === 'unavailable') continue
        try {
          await saveOriginalFile({
            fileHash: result.record.fileHash,
            fileName: result.record.fileName,
            mimeType: raw.mimeType,
            data: raw.buffer.slice(0),
            importId: result.record.id,
            parserId: result.record.parserId,
          })
        } catch {
          // IndexedDB quota or private-mode limits must not break the import itself.
        }
      }
      await refresh()
      return results.map((result) => result.record)
    },
    [refresh, settings.demoMode],
  )

  const loadDemoData = useCallback(async () => {
    await clearDemoData()
    await persistImportResults(buildDemoDataset())
    await refresh()
  }, [refresh])

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
    const payload = await exportDataBackup()
    triggerDownload(
      new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }),
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
          const preview = await previewFullBackupZip(file)
          const result = await restoreFullBackupZip(file)
          await refresh()
          const base = `已恢复 ${result.transactions} 笔交易、${result.statements} 份账单、${result.files} 个原始文件。`
          return { ok: true, message: preview.warning ? `${base}${preview.warning}。` : base }
        }
        const payload: unknown = JSON.parse(await file.text())
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

  const visibleStatements = useMemo(
    () => (settings.demoMode ? snapshot.statements.filter((row) => row.isDemo) : snapshot.statements.filter((row) => !row.isDemo)),
    [settings.demoMode, snapshot.statements],
  )
  const visibleTransactions = useMemo(
    () => (settings.demoMode ? snapshot.transactions.filter((row) => row.isDemo) : snapshot.transactions.filter((row) => !row.isDemo)),
    [settings.demoMode, snapshot.transactions],
  )
  const visibleImports = useMemo(
    () => (settings.demoMode ? snapshot.imports.filter((row) => row.isDemo) : snapshot.imports.filter((row) => !row.isDemo)),
    [settings.demoMode, snapshot.imports],
  )

  const api = useMemo<AppApi>(
    () => ({
      state: { ...snapshot, ready, settings, notes, progress, demoMode: settings.demoMode },
      refresh,
      setSettings,
      importFiles,
      loadDemoData,
      updateTransaction: patchTransaction,
      saveNote,
      backup,
      backupData,
      backupFull,
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
      loadDemoData,
      patchTransaction,
      saveNote,
      backup,
      backupData,
      backupFull,
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

async function safeHash(file: File): Promise<string> {
  try {
    return await sha256Hex(await file.arrayBuffer())
  } catch {
    return 'unavailable'
  }
}

async function persistFailureRecords(results: IngestResult[]): Promise<void> {
  const failures = results.filter((result) => result.statement === null)
  if (failures.length === 0) return
  await db.imports.bulkPut(failures.map((result) => result.record))
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