import * as XLSX from 'xlsx'
import { beforeEach, describe, expect, it } from 'vitest'
import { db } from '../src/db/db'
import { readSnapshot } from '../src/db/repository'
import { minorToDecimalString } from '../src/core/money'
import { emptySummary } from '../src/parsers/types'
import type { Statement, Transaction } from '../src/core/types'
import {
  LEDGER_STATEMENT_HEADERS,
  LEDGER_TRANSACTION_HEADERS,
  LEDGER_ARCHIVE_STATEMENT_SHEET,
  LEDGER_ARCHIVE_TRANSACTION_SHEET,
  buildLedgerArchiveBuffer,
} from '../src/export/ledgerArchive'

beforeEach(async () => {
  await db.delete()
  await db.open()
})

function syntheticTransaction(overrides: Partial<Transaction> & { id: string }): Transaction {
  return {
    statementId: 'synthetic-stmt-1',
    bank: 'boc',
    cardLast4: '1234',
    transactionDate: '2024-01-05',
    postingDate: '2024-01-06',
    description: '消费 合成商户',
    rawDescription: '消费 合成商户',
    merchant: '合成商户',
    transactionCurrency: 'CNY',
    transactionAmountMinor: 12880,
    settlementCurrency: 'CNY',
    settlementAmountMinor: 12880,
    type: 'purchase',
    direction: 'debit',
    category: '未分类',
    confidence: 1,
    flags: [],
    reviewStatus: 'ok',
    sourceFileName: 'synthetic.txt',
    sourceFileHash: 'synthetic-hash',
    sourcePage: null,
    sourceRow: 1,
    rawText: 'synthetic row',
    fingerprint: 'synthetic-fp',
    occurrence: 1,
    isDemo: false,
    ...overrides,
  }
}

function syntheticStatement(overrides: Partial<Statement> & { id: string }): Statement {
  return {
    statementKey: `key-${overrides.id}`,
    bank: 'boc',
    cardLast4: '1234',
    cycleStart: '2024-01-01',
    cycleEnd: '2024-01-31',
    dueDate: null,
    summary: emptySummary(),
    reconciliation: { status: 'passed', checks: [], computedBalanceMinor: 0 },
    status: 'reconciled',
    parserId: 'synthetic',
    parserVersion: '1',
    transactionCount: 0,
    sourceFileName: 'synthetic.txt',
    sourceFileHash: 'synthetic-hash',
    importedAt: '2024-02-01T00:00:00.000Z',
    isDemo: false,
    ...overrides,
  }
}

/** Synthetic ledger only: multi-currency legs plus a repeated fingerprint. */
function seedLedger(): { transactions: Transaction[]; statements: Statement[] } {
  const statements: Statement[] = [
    syntheticStatement({
      id: 'synthetic-stmt-1',
      bank: 'boc',
      cardLast4: '1234',
      cycleStart: '2024-01-01',
      cycleEnd: '2024-01-31',
      transactionCount: 3,
      importedAt: '2024-02-01T10:00:00.000Z',
      status: 'reconciled',
    }),
    syntheticStatement({
      id: 'synthetic-stmt-2',
      bank: 'icbc',
      cardLast4: '5678',
      cycleStart: '2024-02-01',
      cycleEnd: '2024-02-29',
      transactionCount: 3,
      importedAt: '2024-03-01T10:00:00.000Z',
      status: 'needs_review',
    }),
  ]
  const transactions: Transaction[] = [
    syntheticTransaction({
      id: 'synthetic-tx-cny-1',
      statementId: 'synthetic-stmt-1',
      bank: 'boc',
      cardLast4: '1234',
      transactionDate: '2024-01-05',
      postingDate: '2024-01-06',
      description: '消费 合成咖啡',
      transactionCurrency: 'CNY',
      transactionAmountMinor: 12880,
      settlementCurrency: 'CNY',
      settlementAmountMinor: 12880,
      type: 'purchase',
      direction: 'debit',
      fingerprint: 'synthetic-fp-cny-1',
      occurrence: 1,
      sourceRow: 1,
    }),
    syntheticTransaction({
      id: 'synthetic-tx-usd-1',
      statementId: 'synthetic-stmt-1',
      bank: 'boc',
      cardLast4: '1234',
      transactionDate: '2024-01-07',
      postingDate: '2024-01-08',
      description: '消费 合成书店',
      transactionCurrency: 'USD',
      transactionAmountMinor: 1800,
      settlementCurrency: 'CNY',
      settlementAmountMinor: 12960,
      type: 'purchase',
      direction: 'debit',
      fingerprint: 'synthetic-fp-usd-1',
      occurrence: 1,
      sourceRow: 2,
    }),
    syntheticTransaction({
      id: 'synthetic-tx-jpy-1',
      statementId: 'synthetic-stmt-1',
      bank: 'boc',
      cardLast4: '1234',
      transactionDate: '2024-01-09',
      postingDate: '2024-01-10',
      description: '消费 合成文具',
      transactionCurrency: 'JPY',
      transactionAmountMinor: 1200,
      settlementCurrency: 'USD',
      settlementAmountMinor: 1005,
      type: 'purchase',
      direction: 'debit',
      fingerprint: 'synthetic-fp-jpy-1',
      occurrence: 1,
      sourceRow: 3,
    }),
    syntheticTransaction({
      id: 'synthetic-tx-dup-1',
      statementId: 'synthetic-stmt-2',
      bank: 'icbc',
      cardLast4: '5678',
      transactionDate: '2024-02-07',
      postingDate: '2024-02-08',
      description: '消费 合成超市',
      transactionCurrency: 'CNY',
      transactionAmountMinor: 5000,
      settlementCurrency: 'CNY',
      settlementAmountMinor: 5000,
      type: 'purchase',
      direction: 'debit',
      fingerprint: 'synthetic-fp-dup',
      occurrence: 1,
      sourceRow: 1,
    }),
    syntheticTransaction({
      id: 'synthetic-tx-dup-2',
      statementId: 'synthetic-stmt-2',
      bank: 'icbc',
      cardLast4: '5678',
      transactionDate: '2024-02-07',
      postingDate: '2024-02-08',
      description: '消费 合成超市',
      transactionCurrency: 'CNY',
      transactionAmountMinor: 5000,
      settlementCurrency: 'CNY',
      settlementAmountMinor: 5000,
      type: 'purchase',
      direction: 'debit',
      fingerprint: 'synthetic-fp-dup',
      occurrence: 2,
      sourceRow: 2,
    }),
    syntheticTransaction({
      id: 'synthetic-tx-eur-refund-1',
      statementId: 'synthetic-stmt-2',
      bank: 'icbc',
      cardLast4: '5678',
      transactionDate: '2024-02-09',
      postingDate: '2024-02-10',
      description: '退货 合成商城',
      transactionCurrency: 'EUR',
      transactionAmountMinor: -2500,
      settlementCurrency: 'CNY',
      settlementAmountMinor: -18000,
      type: 'refund',
      direction: 'credit',
      fingerprint: 'synthetic-fp-eur-1',
      occurrence: 1,
      sourceRow: 3,
    }),
  ]
  // Keep stored statement counts exact (3 + 3 = 6 rows).
  return { transactions, statements }
}

function sheetRows(buffer: ArrayBuffer, name: string): unknown[][] {
  const workbook = XLSX.read(buffer, { type: 'array' })
  const sheet = workbook.Sheets[name]
  expect(sheet).toBeDefined()
  return XLSX.utils.sheet_to_json<unknown[]>(sheet!, { header: 1, raw: true, defval: null }) as unknown[][]
}

describe('ledger XLSX archive', () => {
  it('opens with Transactions and Statements sheets and matches database counts', async () => {
    const { transactions, statements } = seedLedger()
    await db.statements.bulkPut(statements)
    await db.transactions.bulkPut(transactions)
    expect(await db.transactions.count()).toBe(transactions.length)

    const snapshot = await readSnapshot()
    const buffer = await buildLedgerArchiveBuffer(snapshot.transactions, snapshot.statements)

    // Can be opened independently.
    const workbook = XLSX.read(buffer, { type: 'array' })
    expect(workbook.SheetNames).toEqual([LEDGER_ARCHIVE_TRANSACTION_SHEET, LEDGER_ARCHIVE_STATEMENT_SHEET])

    const transactionRows = sheetRows(buffer, LEDGER_ARCHIVE_TRANSACTION_SHEET)
    const statementRows = sheetRows(buffer, LEDGER_ARCHIVE_STATEMENT_SHEET)
    expect(transactionRows[0]).toEqual([...LEDGER_TRANSACTION_HEADERS])
    expect(statementRows[0]).toEqual([...LEDGER_STATEMENT_HEADERS])
    // Header + one row per stored record.
    expect(transactionRows.length - 1).toBe(transactions.length)
    expect(statementRows.length - 1).toBe(statements.length)
  })

  it('keeps transaction IDs unchanged', async () => {
    const { transactions, statements } = seedLedger()
    await db.statements.bulkPut(statements)
    await db.transactions.bulkPut(transactions)
    const snapshot = await readSnapshot()
    const buffer = await buildLedgerArchiveBuffer(snapshot.transactions, snapshot.statements)

    const rows = sheetRows(buffer, LEDGER_ARCHIVE_TRANSACTION_SHEET)
    const idIndex = [...LEDGER_TRANSACTION_HEADERS].indexOf('transaction_id')
    const exportedIds = rows.slice(1).map((row) => String(row[idIndex]))
    expect(new Set(exportedIds).size).toBe(transactions.length)
    expect([...exportedIds].sort()).toEqual(transactions.map((tx) => tx.id).sort())
  })

  it('keeps multi-currency amounts unchanged without conversion', async () => {
    const { transactions, statements } = seedLedger()
    await db.statements.bulkPut(statements)
    await db.transactions.bulkPut(transactions)
    const snapshot = await readSnapshot()
    const buffer = await buildLedgerArchiveBuffer(snapshot.transactions, snapshot.statements)

    const rows = sheetRows(buffer, LEDGER_ARCHIVE_TRANSACTION_SHEET)
    const headers = [...LEDGER_TRANSACTION_HEADERS]
    const byId = new Map(rows.slice(1).map((row) => [String(row[headers.indexOf('transaction_id')]), row]))
    for (const tx of transactions) {
      const row = byId.get(tx.id)
      expect(row).toBeDefined()
      expect(String(row![headers.indexOf('original_currency')])).toBe(tx.transactionCurrency)
      expect(String(row![headers.indexOf('original_amount')])).toBe(
        minorToDecimalString(tx.transactionAmountMinor, tx.transactionCurrency),
      )
      expect(String(row![headers.indexOf('settlement_currency')])).toBe(tx.settlementCurrency)
      expect(String(row![headers.indexOf('settlement_amount')])).toBe(
        minorToDecimalString(tx.settlementAmountMinor, tx.settlementCurrency),
      )
    }
    // Spot-check zero-decimal and negative legs stay exact.
    const jpy = byId.get('synthetic-tx-jpy-1')!
    expect(String(jpy[headers.indexOf('original_currency')])).toBe('JPY')
    expect(String(jpy[headers.indexOf('original_amount')])).toBe('1200')
    expect(String(jpy[headers.indexOf('settlement_amount')])).toBe('10.05')
    const eur = byId.get('synthetic-tx-eur-refund-1')!
    expect(String(eur[headers.indexOf('original_amount')])).toBe('-25.00')
    expect(String(eur[headers.indexOf('settlement_amount')])).toBe('-180.00')
  })

  it('preserves duplicate fingerprint and occurrence metadata', async () => {
    const { transactions, statements } = seedLedger()
    await db.statements.bulkPut(statements)
    await db.transactions.bulkPut(transactions)
    const snapshot = await readSnapshot()
    const buffer = await buildLedgerArchiveBuffer(snapshot.transactions, snapshot.statements)

    const rows = sheetRows(buffer, LEDGER_ARCHIVE_TRANSACTION_SHEET)
    const headers = [...LEDGER_TRANSACTION_HEADERS]
    const byId = new Map(rows.slice(1).map((row) => [String(row[headers.indexOf('transaction_id')]), row]))
    for (const tx of transactions) {
      const row = byId.get(tx.id)!
      expect(String(row[headers.indexOf('duplicate_fingerprint')])).toBe(tx.fingerprint)
      expect(Number(row[headers.indexOf('duplicate_occurrence')])).toBe(tx.occurrence)
      expect(String(row[headers.indexOf('source_statement')])).toBe(tx.statementId)
    }
    // Both occurrences of the same fingerprint survive as distinct rows.
    const dupRows = rows.slice(1).filter(
      (row) => String(row[headers.indexOf('duplicate_fingerprint')]) === 'synthetic-fp-dup',
    )
    expect(dupRows.map((row) => Number(row[headers.indexOf('duplicate_occurrence')])).sort()).toEqual([1, 2])
    expect(dupRows.map((row) => String(row[headers.indexOf('transaction_id')])).sort()).toEqual(
      ['synthetic-tx-dup-1', 'synthetic-tx-dup-2'],
    )
  })

  it('preserves statement identity, period, counts and validation status', async () => {
    const { transactions, statements } = seedLedger()
    await db.statements.bulkPut(statements)
    await db.transactions.bulkPut(transactions)
    const snapshot = await readSnapshot()
    const buffer = await buildLedgerArchiveBuffer(snapshot.transactions, snapshot.statements)

    const rows = sheetRows(buffer, LEDGER_ARCHIVE_STATEMENT_SHEET)
    const headers = [...LEDGER_STATEMENT_HEADERS]
    const byId = new Map(rows.slice(1).map((row) => [String(row[headers.indexOf('statement_id')]), row]))
    expect([...byId.keys()].sort()).toEqual(statements.map((st) => st.id).sort())
    for (const st of statements) {
      const row = byId.get(st.id)!
      expect(String(row[headers.indexOf('bank')])).toBe(st.bank)
      expect(String(row[headers.indexOf('card_last4')])).toBe(st.cardLast4)
      expect(String(row[headers.indexOf('statement_period')])).toContain(st.cycleStart ?? '')
      expect(String(row[headers.indexOf('statement_period')])).toContain(st.cycleEnd ?? '')
      // Stored count is kept verbatim, never recomputed.
      expect(Number(row[headers.indexOf('transaction_count')])).toBe(st.transactionCount)
      expect(String(row[headers.indexOf('imported_at')])).toBe(st.importedAt)
      expect(String(row[headers.indexOf('validation_status')])).toBe(st.status)
    }
  })
})
