/**
 * Human-readable ledger archive (XLSX).
 *
 * Separate from JSON backup:
 * - JSON backup (`exportDataBackup`) = complete restore format.
 * - XLSX archive here = human-readable, externally viewable format.
 *
 * Guarantees:
 * - Reuses the existing TypeScript data model (`Transaction`, `Statement`).
 * - Preserves exact stored values: no recalculation, no currency conversion.
 * - Amounts are rendered from integer minor units via `minorToDecimalString`
 *   and stored as text so Excel/LibreOffice never lose precision to floats.
 * - No database schema change, no ID change, no import logic change.
 */

import { minorToDecimalString } from '../core/money'
import type { Statement, Transaction } from '../core/types'
import { triggerDownload } from './tabular'

export const LEDGER_ARCHIVE_TRANSACTION_SHEET = 'Transactions'
export const LEDGER_ARCHIVE_STATEMENT_SHEET = 'Statements'

/**
 * 15 columns, in task order:
 * transaction ID / bank / card last four / transaction date / posting date /
 * description / transaction type / direction / original currency /
 * original amount / settlement currency / settlement amount /
 * duplicate fingerprint / duplicate occurrence / source statement
 */
export const LEDGER_TRANSACTION_HEADERS = [
  'transaction_id',
  'bank',
  'card_last4',
  'transaction_date',
  'posting_date',
  'description',
  'transaction_type',
  'direction',
  'original_currency',
  'original_amount',
  'settlement_currency',
  'settlement_amount',
  'duplicate_fingerprint',
  'duplicate_occurrence',
  'source_statement',
] as const

/**
 * 7 columns, in task order:
 * statement ID / bank / card last four / statement period /
 * transaction count / import timestamp / validation status
 */
export const LEDGER_STATEMENT_HEADERS = [
  'statement_id',
  'bank',
  'card_last4',
  'statement_period',
  'transaction_count',
  'imported_at',
  'validation_status',
] as const

export type LedgerArchiveCell = string | number | null

/** Strip characters that are illegal in XLSX XML so the file opens in Excel/LibreOffice. */
export function sanitizeArchiveText(value: string): string {
  // Same class Python exporter strips: C0 controls except \t \n \r, plus surrogates.
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uD800-\uDFFF]/g, '')
}

function text(value: string | null | undefined): string {
  if (value === null || value === undefined) return ''
  return sanitizeArchiveText(value)
}

/**
 * One archive row preserves exact stored values:
 * - IDs, bank ids, card suffixes, ISO dates, descriptions as stored.
 * - `type` / `direction` as stored enums (no label recalculation).
 * - Currencies as stored codes; amounts as exact decimal strings from
 *   integer minor units (no float math, no FX conversion).
 * - Fingerprint, occurrence and source statement id verbatim.
 */
export function transactionToArchiveRow(transaction: Transaction): LedgerArchiveCell[] {
  return [
    text(transaction.id),
    text(transaction.bank),
    text(transaction.cardLast4),
    text(transaction.transactionDate ?? ''),
    text(transaction.postingDate ?? ''),
    text(transaction.description),
    text(transaction.type),
    text(transaction.direction),
    text(transaction.transactionCurrency),
    text(minorToDecimalString(transaction.transactionAmountMinor, transaction.transactionCurrency)),
    text(transaction.settlementCurrency),
    text(minorToDecimalString(transaction.settlementAmountMinor, transaction.settlementCurrency)),
    text(transaction.fingerprint),
    transaction.occurrence,
    text(transaction.statementId),
  ]
}

/**
 * One statement row preserves exact stored values:
 * - `transaction_count` is the stored `transactionCount`, never recomputed
 *   from the transaction list.
 * - `statement_period` keeps both stored cycle dates verbatim.
 * - `validation_status` is the stored statement status verbatim.
 */
export function statementToArchiveRow(statement: Statement): LedgerArchiveCell[] {
  const period = `${statement.cycleStart ?? ''} ~ ${statement.cycleEnd ?? ''}`
  return [
    text(statement.id),
    text(statement.bank),
    text(statement.cardLast4),
    text(period),
    statement.transactionCount,
    text(statement.importedAt),
    text(statement.status),
  ]
}

function sortTransactions(rows: Transaction[]): Transaction[] {
  return [...rows].sort((a, b) => {
    const byDate = (a.transactionDate ?? '').localeCompare(b.transactionDate ?? '')
    if (byDate !== 0) return byDate
    const byPosting = (a.postingDate ?? '').localeCompare(b.postingDate ?? '')
    if (byPosting !== 0) return byPosting
    return a.id.localeCompare(b.id)
  })
}

function sortStatements(rows: Statement[]): Statement[] {
  return [...rows].sort((a, b) => {
    const byEnd = (a.cycleEnd ?? '').localeCompare(b.cycleEnd ?? '')
    if (byEnd !== 0) return byEnd
    const byStart = (a.cycleStart ?? '').localeCompare(b.cycleStart ?? '')
    if (byStart !== 0) return byStart
    return a.id.localeCompare(b.id)
  })
}

export interface LedgerArchiveContent {
  transactionRows: LedgerArchiveCell[][]
  statementRows: LedgerArchiveCell[][]
}

/** Deterministic row order; values themselves are never recalculated. */
export function buildLedgerArchiveContent(
  transactions: Transaction[],
  statements: Statement[],
): LedgerArchiveContent {
  return {
    transactionRows: sortTransactions(transactions).map(transactionToArchiveRow),
    statementRows: sortStatements(statements).map(statementToArchiveRow),
  }
}

/** Build an independently openable XLSX buffer with Transactions + Statements. */
export async function buildLedgerArchiveBuffer(
  transactions: Transaction[],
  statements: Statement[],
): Promise<ArrayBuffer> {
  const XLSX = await import('xlsx')
  const { transactionRows, statementRows } = buildLedgerArchiveContent(transactions, statements)
  const transactionSheet = XLSX.utils.aoa_to_sheet([
    [...LEDGER_TRANSACTION_HEADERS],
    ...transactionRows,
  ])
  const statementSheet = XLSX.utils.aoa_to_sheet([
    [...LEDGER_STATEMENT_HEADERS],
    ...statementRows,
  ])
  transactionSheet['!cols'] = [...LEDGER_TRANSACTION_HEADERS].map((header) => ({
    wch: Math.min(48, Math.max(14, header.length + 4)),
  }))
  statementSheet['!cols'] = [...LEDGER_STATEMENT_HEADERS].map((header) => ({
    wch: Math.min(48, Math.max(14, header.length + 4)),
  }))
  const book = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(book, transactionSheet, LEDGER_ARCHIVE_TRANSACTION_SHEET)
  XLSX.utils.book_append_sheet(book, statementSheet, LEDGER_ARCHIVE_STATEMENT_SHEET)
  return XLSX.write(book, { bookType: 'xlsx', type: 'array' }) as ArrayBuffer
}

export function ledgerArchiveFileName(now = new Date()): string {
  return `keepraw-ledger-archive-${now.toISOString().slice(0, 10)}.xlsx`
}

/** Download the current ledger as a human-readable workbook (not a restore file). */
export async function downloadLedgerArchive(
  fileName: string,
  transactions: Transaction[],
  statements: Statement[],
): Promise<void> {
  const buffer = await buildLedgerArchiveBuffer(transactions, statements)
  triggerDownload(
    new Blob([buffer], {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    }),
    fileName,
  )
}
