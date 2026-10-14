import { beforeEach, expect, it } from 'vitest'
import { db } from '../src/db/db'
import { persistImportResults, readSnapshot } from '../src/db/repository'
import { ingestParsedStatement } from '../src/core/ingest'
import { buildSourceDocument, pdfToText } from '../src/parsers/extract'
import { detectParser, parseDocument } from '../src/parsers/registry'
import type { SourceDocument } from '../src/parsers/types'
import { buildSyntheticBocPdf } from './fixtures/bocPdf'
import { SYNTHETIC_CCB_HTML } from './fixtures/ccbEml'
import { SYNTHETIC_ICBC_HTML } from './fixtures/icbcEml'
import { SYNTHETIC_ABC_HTML } from './fixtures/abcEml'
import { SYNTHETIC_BOCOM_HTML } from './fixtures/bocomEml'
import { SYNTHETIC_CITIC_HTML } from './fixtures/citicEml'

// Independently specified invented fixture values, never derived from parser output.
// These supplement the immutable historical Golden JSON; they do not regenerate it.
type ReferenceRow = readonly [number, string]
const COMMON: ReferenceRow[] = [
  [-300000, 'payment'], [-240000, 'refund'], [-180000, 'refund'],
  [90000, 'installment_original'], [30000, 'installment_payment'], [6800, 'purchase'],
  [120000, 'purchase'], [8650, 'purchase'], [240000, 'purchase'], [180000, 'purchase'],
  [3420, 'purchase'], [41130, 'purchase'], [10000, 'purchase'], [10000, 'purchase'],
]
const REFERENCES: Record<string, ReferenceRow[]> = {
  boc: [[4800, 'purchase'], [15200, 'purchase'], [100000, 'purchase'], [-300000, 'payment'],
    [-100000, 'payment'], [-100000, 'payment'], [-60000, 'payment']],
  ccb: COMMON, bocom: COMMON, abc: COMMON,
  icbc: [[-300000, 'payment'], [-20000, 'refund'], [90000, 'installment_original'], [30000, 'installment_payment'],
    [6800, 'purchase'], [120000, 'purchase'], [8650, 'purchase'], [220000, 'purchase'], [3420, 'purchase'],
    [1130, 'purchase'], [10000, 'purchase'], [10000, 'purchase'], [-5000, 'cashback']],
  citic: [[-1000000, 'payment'], [120000, 'purchase'], [80000, 'purchase'], [5000, 'purchase'], [5000, 'purchase']],
}
const SOURCES: Record<string, string> = {
  ccb: SYNTHETIC_CCB_HTML, icbc: SYNTHETIC_ICBC_HTML, abc: SYNTHETIC_ABC_HTML,
  bocom: SYNTHETIC_BOCOM_HTML, citic: SYNTHETIC_CITIC_HTML,
}

beforeEach(async () => { await db.delete(); await db.open() })

it.each(Object.keys(REFERENCES))('%s: current parser and persisted output match independent financial references with multiplicity', async (bank) => {
  let doc: SourceDocument
  if (bank === 'boc') {
    const pdf = buildSyntheticBocPdf()
    doc = { fileName: 'synthetic.pdf', fileHash: 'synthetic', fileSize: 1, sourceType: 'pdf', pdf,
      html: null, tables: [], text: pdfToText(pdf), email: null }
  } else {
    doc = await buildSourceDocument({ fileName: 'synthetic.html', fileHash: 'synthetic', buffer: new TextEncoder().encode(SOURCES[bank]!).buffer })
  }
  const match = detectParser(doc)!
  expect(match.parser.bank).toBe(bank)
  const parsed = parseDocument(doc, match.parser)
  const result = ingestParsedStatement(parsed, { fileName: doc.fileName, fileHash: doc.fileHash, fileSize: 1, sourceType: doc.sourceType }, await readSnapshot())
  await persistImportResults([result])
  const expected = REFERENCES[bank]!.map(([minor, type]) =>
    JSON.stringify(['CNY', minor, 'CNY', minor, minor < 0 ? 'credit' : 'debit', type])).sort()
  const financialRows = (rows: typeof parsed.transactions) => rows.map((row) => JSON.stringify([
    row.transactionCurrency, row.transactionAmountMinor, row.settlementCurrency, row.settlementAmountMinor, row.direction, row.type,
  ])).sort()
  expect(parsed.transactions).toHaveLength(expected.length)
  expect(financialRows(parsed.transactions)).toEqual(expected)
  const stored = await db.transactions.toArray()
  expect(stored).toHaveLength(expected.length)
  expect(new Set(stored.map((row) => row.id)).size).toBe(expected.length)
  expect(stored.map((row) => JSON.stringify([
    row.transactionCurrency, row.transactionAmountMinor, row.settlementCurrency, row.settlementAmountMinor, row.direction, row.type,
  ])).sort()).toEqual(expected)
})
