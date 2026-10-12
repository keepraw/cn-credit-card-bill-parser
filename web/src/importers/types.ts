import type { IsoDate } from '../core/dates'
import type { BankId, Category, Direction, TransactionType } from '../core/types'

/**
 * Legacy Import adapters.
 *
 * A Legacy Adapter migrates *structured history from a known previous system*
 * into the current standard Transaction. It is deliberately NOT a generic
 * spreadsheet importer: an upload that does not match a known adapter schema
 * is rejected instead of guessed.
 *
 * Adapters live here, never in `src/parsers/`. Bank parsers turn bank
 * statements into data; adapters turn old-system data into data.
 */

/** The only historical format supported in this phase. */
export const LEGACY_PYTHON_EXPORT_V1 = 'legacy-python-export-v1' as const
export type LegacyFormatId = typeof LEGACY_PYTHON_EXPORT_V1

export const LEGACY_FORMAT_NAME: Record<LegacyFormatId, string> = {
  [LEGACY_PYTHON_EXPORT_V1]: 'Legacy Python Export',
}

export interface LegacyFileMeta {
  fileName: string
  fileSize: number
  fileHash: string
}

export type LegacyAnomalyKind = 'missing_field' | 'date_unparseable' | 'amount_unparseable'

export interface LegacyAnomaly {
  /** 1-based Excel row number (header is row 1). */
  rowNumber: number
  kind: LegacyAnomalyKind
  detail: string
}

/** One validated history row, mapped to standard units but not yet identified. */
export interface NormalizedLegacyRow {
  bank: BankId
  cardLast4: string
  transactionDate: IsoDate | null
  postingDate: IsoDate | null
  description: string
  rawDescription: string
  merchant: string
  transactionCurrency: string
  transactionAmountMinor: number
  settlementCurrency: string
  settlementAmountMinor: number
  type: TransactionType
  direction: Direction
  category: Category
  confidence: number
  flags: import('../core/types').ReviewFlag[]
  rawText: string
  /** 1-based Excel row number. Provenance only, never used for identity. */
  sourceRow: number
  cycleStart: IsoDate | null
  cycleEnd: IsoDate | null
}

export interface LegacyPreviewStats {
  formatId: LegacyFormatId
  formatName: string
  /** Non-empty data rows seen in the sheet. */
  totalRows: number
  validRows: number
  anomalyRows: number
  anomaliesByKind: Record<LegacyAnomalyKind, number>
  dateRange: { min: IsoDate; max: IsoDate } | null
  banks: BankId[]
  /** Rows whose fingerprint already exists in storage (would be skipped). */
  alreadyStored: number
  /** True when this exact file (SHA-256) was imported before. */
  duplicateFile: boolean
}

export interface LegacyPreview {
  meta: LegacyFileMeta
  stats: LegacyPreviewStats
  /** Valid rows with stable ids assigned (deterministic per batch). */
  rows: Array<NormalizedLegacyRow & { id: string; fingerprint: string; occurrence: number }>
  anomalies: LegacyAnomaly[]
}
