import { assignOccurrences, detectDuplicates, transactionId } from '../core/dedupe'
import { statementKey, transactionFingerprint } from '../core/identity'
import { reconcileStatement } from '../core/reconcile'
import type { ImportRecord, Statement, Transaction } from '../core/types'
import { emptySummary } from '../parsers/types'
import { sha256Hex } from '../parsers/extract'
import { LEGACY_STANDARD_SHEET, detectLegacyShape, parseLegacyRows } from './legacyPythonExportV1'
import {
  LEGACY_PYTHON_EXPORT_V1,
  LEGACY_FORMAT_NAME,
  type LegacyAnomaly,
  type LegacyFileMeta,
  type LegacyPreview,
  type NormalizedLegacyRow,
} from './types'
import { readSheetData } from './workbook'

export const LEGACY_ADAPTER_VERSION = '1.0.0'
export const LEGACY_IMPORT_BATCH = 2000

export class LegacyFormatError extends Error {
  constructor(message = '无法识别该历史数据格式') {
    super(message)
    this.name = 'LegacyFormatError'
  }
}

export interface LegacyExisting {
  imports: ImportRecord[]
  statements: Statement[]
  transactions: Transaction[]
}

export type PreviewRow = LegacyPreview['rows'][number]

function fingerprintOf(row: NormalizedLegacyRow): string {
  return transactionFingerprint({
    bank: row.bank,
    cardLast4: row.cardLast4,
    transactionDate: row.transactionDate,
    postingDate: row.postingDate,
    settlementCurrency: row.settlementCurrency,
    settlementAmountMinor: row.settlementAmountMinor,
    type: row.type,
    description: row.description,
  })
}

/**
 * Read-only preview. Parses the workbook, detects the adapter, maps every
 * row and compares fingerprints against storage. Writes nothing.
 */
export async function previewLegacyWorkbook(
  buffer: ArrayBuffer,
  meta: LegacyFileMeta,
  existing: LegacyExisting,
): Promise<LegacyPreview> {
  const { rows: sheetRows } = await readSheetData(buffer, LEGACY_STANDARD_SHEET)
  if (sheetRows.length === 0) throw new LegacyFormatError()
  const shape = detectLegacyShape(sheetRows[0] as unknown[])
  if (!shape) throw new LegacyFormatError()
  const parsed = parseLegacyRows(sheetRows.slice(1) as unknown[][], shape)

  const fingerprints = parsed.rows.map(fingerprintOf)
  const occurrences = assignOccurrences(fingerprints)
  const rows: PreviewRow[] = parsed.rows.map((row, index) => {
    const fingerprint = fingerprints[index]!
    const occurrence = occurrences[index]!.occurrence
    return { ...row, id: transactionId(fingerprint, occurrence), fingerprint, occurrence }
  })

  const { duplicateIds } = detectDuplicates(
    rows.map((row) => ({
      id: row.id,
      fingerprint: row.fingerprint,
      bank: row.bank,
      cardLast4: row.cardLast4,
      transactionDate: row.transactionDate,
      settlementAmountMinor: row.settlementAmountMinor,
      type: row.type,
      description: row.description,
    })),
    existing.transactions.map((tx) => ({
      fingerprint: tx.fingerprint,
      bank: tx.bank,
      cardLast4: tx.cardLast4,
      transactionDate: tx.transactionDate,
      settlementAmountMinor: tx.settlementAmountMinor,
      type: tx.type,
      description: tx.description,
    })),
  )

  const dates = rows
    .map((row) => row.transactionDate)
    .filter((date): date is string => date !== null)
    .sort()
  const banks = [...new Set(rows.map((row) => row.bank))].sort()
  const anomaliesByKind: Record<LegacyAnomaly['kind'], number> = {
    missing_field: 0,
    date_unparseable: 0,
    amount_unparseable: 0,
  }
  for (const anomaly of parsed.anomalies) anomaliesByKind[anomaly.kind] += 1

  return {
    meta,
    stats: {
      formatId: LEGACY_PYTHON_EXPORT_V1,
      formatName: LEGACY_FORMAT_NAME[LEGACY_PYTHON_EXPORT_V1],
      totalRows: parsed.totalRows,
      validRows: rows.length,
      anomalyRows: parsed.anomalies.length,
      anomaliesByKind,
      dateRange: dates.length > 0 ? { min: dates[0]!, max: dates[dates.length - 1]! } : null,
      banks,
      alreadyStored: rows.filter((row) => duplicateIds.has(row.id)).length,
      duplicateFile: existing.imports.some((record) => record.fileHash === meta.fileHash),
    },
    rows,
    anomalies: parsed.anomalies,
  }
}

export interface LegacyConfirmPlan {
  record: ImportRecord
  statements: Statement[]
  /** Only rows not already stored. */
  inserted: Transaction[]
  skipped: number
  anomalies: LegacyAnomaly[]
}

/**
 * Build the write plan for rows the user already previewed. Re-checks
 * identity against a fresh snapshot so a concurrent import cannot duplicate.
 * Pure: performs no database access itself.
 */
export function planLegacyImport(preview: LegacyPreview, existing: LegacyExisting): LegacyConfirmPlan {
  const storedIds = new Set(existing.transactions.map((tx) => tx.id))
  const fresh = preview.rows.filter((row) => !storedIds.has(row.id))
  const skipped = preview.rows.length - fresh.length

  const transactions: Transaction[] = fresh.map((row) => ({
    id: row.id,
    statementId: statementKey(row.bank, row.cardLast4, row.cycleStart, row.cycleEnd),
    bank: row.bank,
    cardLast4: row.cardLast4,
    transactionDate: row.transactionDate,
    postingDate: row.postingDate,
    description: row.description,
    rawDescription: row.rawDescription,
    merchant: row.merchant,
    transactionCurrency: row.transactionCurrency,
    transactionAmountMinor: row.transactionAmountMinor,
    settlementCurrency: row.settlementCurrency,
    settlementAmountMinor: row.settlementAmountMinor,
    type: row.type,
    direction: row.direction,
    category: row.category,
    confidence: row.confidence,
    flags: [...row.flags],
    reviewStatus: row.flags.length > 0 ? 'pending' : 'ok',
    sourceFileName: preview.meta.fileName,
    sourceFileHash: preview.meta.fileHash,
    sourcePage: null,
    sourceRow: row.sourceRow,
    rawText: row.rawText,
    fingerprint: row.fingerprint,
    occurrence: row.occurrence,
    isDemo: false,
    origin: 'legacy_import',
    sourceId: LEGACY_PYTHON_EXPORT_V1,
  }))

  // Group the file's valid rows into per-period statements. Statements are
  // rebuilt deterministically, so a repeat import reproduces identical rows
  // and the merge stays idempotent.
  const groups = new Map<string, PreviewRow[]>()
  for (const row of preview.rows) {
    const key = statementKey(row.bank, row.cardLast4, row.cycleStart, row.cycleEnd)
    const bucket = groups.get(key) ?? []
    bucket.push(row)
    groups.set(key, bucket)
  }

  const now = new Date().toISOString()
  const insertedIds = new Set(transactions.map((tx) => tx.id))
  const statements: Statement[] = [...groups.entries()].map(([key, bucket]) => {
    const first = bucket[0]!
    const priorCount = existing.transactions.filter((tx) => tx.statementId === key && !tx.isDemo).length
    // Legacy data carries no balance summary, so reconciliation is honestly
    // `insufficient` — never passed, never faked.
    const reconciliation = reconcileStatement({ summary: emptySummary(), transactions: [] })
    return {
      id: key,
      statementKey: key,
      bank: first.bank,
      cardLast4: first.cardLast4,
      cycleStart: first.cycleStart,
      cycleEnd: first.cycleEnd,
      dueDate: null,
      summary: emptySummary(),
      reconciliation,
      status: 'imported',
      parserId: LEGACY_PYTHON_EXPORT_V1,
      parserVersion: LEGACY_ADAPTER_VERSION,
      transactionCount: priorCount + bucket.filter((row) => insertedIds.has(row.id)).length,
      sourceFileName: preview.meta.fileName,
      sourceFileHash: preview.meta.fileHash,
      importedAt: now,
      isDemo: false,
    } satisfies Statement
  })

  const banks = [...new Set(preview.rows.map((row) => row.bank))]
  const cards = [...new Set(preview.rows.map((row) => row.cardLast4))]
  const dates = preview.rows
    .map((row) => row.transactionDate)
    .filter((date): date is string => date !== null)
    .sort()
  const duplicateImport = existing.imports.find((record) => record.fileHash === preview.meta.fileHash)
  const status = duplicateImport ? 'duplicate' : 'imported'

  const record: ImportRecord = {
    id: `${preview.meta.fileHash}:${LEGACY_PYTHON_EXPORT_V1}`,
    fileName: preview.meta.fileName,
    fileSize: preview.meta.fileSize,
    fileHash: preview.meta.fileHash,
    sourceType: 'xlsx',
    bank: banks.length === 1 ? banks[0]! : 'unknown',
    detectedBank: banks.length === 1 ? banks[0]! : 'unknown',
    cardLast4: cards.length === 1 && cards[0] !== '????' ? cards[0]! : '',
    cycleStart: dates.length > 0 ? dates[0]! : null,
    cycleEnd: dates.length > 0 ? dates[dates.length - 1]! : null,
    status,
    message:
      status === 'duplicate' && duplicateImport
        ? `与已导入文件 ${duplicateImport.fileName} 内容完全相同（SHA-256 一致），已跳过`
        : `历史数据迁移（Legacy Python Export）：解析到 ${preview.stats.totalRows} 笔，` +
          `新增 ${transactions.length} 笔，跳过 ${skipped} 笔已存在` +
          (preview.anomalies.length > 0 ? `，${preview.anomalies.length} 行异常已排除` : ''),
    statementId: null,
    transactionCount: transactions.length,
    duplicateOf: duplicateImport?.id ?? null,
    parserId: LEGACY_PYTHON_EXPORT_V1,
    importedAt: now,
    isDemo: false,
  }

  return { record, statements, inserted: transactions, skipped, anomalies: preview.anomalies }
}

/** Hash the raw upload so repeat files are recognised before any work happens. */
export async function hashLegacyFile(file: { size: number; arrayBuffer(): Promise<ArrayBuffer> }) {
  const buffer = await file.arrayBuffer()
  return { buffer, fileHash: await sha256Hex(buffer) }
}
