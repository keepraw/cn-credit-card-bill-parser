import { existsSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { bocomParser } from '../../src/parsers/bocom'
import { bocParser } from '../../src/parsers/boc'
import { extractTables, extractText, sanitizeHtml } from '../../src/parsers/html'
import { buildSourceDocument, sha256Hex } from '../../src/parsers/extract'
import type { SourceDocument } from '../../src/parsers/types'
import { reconcileStatement } from '../../src/core/reconcile'
import { formatMinor } from '../../src/core/money'
import type { Transaction } from '../../src/core/types'
import postalMime from 'postal-mime'

/**
 * Acceptance harness for the two real sample statements.
 *
 * Real statements are private: they are never committed. Point the environment at
 * your own copies to run this file:
 *
 *   PowerShell
 *   $env:CCB_REAL_BOC_PDF = "D:\账单\中国银行....pdf"
 *   $env:CCB_REAL_BOCOM_EML = "D:\账单\交通银行....eml"
 *   npm test -- tests/acceptance/realStatement.test.ts
 *
 * The assertions are deliberately about *invariants* (the balance equation and the
 * detail vs summary agreement), not about hard coded amounts.
 */

const bocPath = process.env.CCB_REAL_BOC_PDF ?? ''
const bocomPath = process.env.CCB_REAL_BOCOM_EML ?? ''

const bocAvailable = bocPath !== '' && existsSync(bocPath)
const bocomAvailable = bocomPath !== '' && existsSync(bocomPath)

async function loadPdfSource(path: string): Promise<SourceDocument> {
  const { readFile } = await import('node:fs/promises')
  const buffer = await readFile(path)
  const fileBuffer = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer
  const fileHash = await sha256Hex(fileBuffer)
  return buildSourceDocument({ fileName: path.split(/[\\/]/).pop() ?? 'statement.pdf', buffer: fileBuffer, fileHash })
}

async function loadEmlSource(path: string): Promise<SourceDocument> {
  const { readFile } = await import('node:fs/promises')
  const bytes = new Uint8Array(await readFile(path))
  const parsed = await postalMime.parse(bytes)
  const html = parsed.html ?? ''
  const safe = sanitizeHtml(html)
  const fileBuffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
  const fileHash = await sha256Hex(fileBuffer)
  return {
    fileName: path.split(/[\\/]/).pop() ?? 'statement.eml',
    fileSize: bytes.byteLength,
    fileHash,
    sourceType: 'eml',
    pdf: null,
    html: safe,
    tables: extractTables(safe),
    text: extractText(safe),
    email: { subject: parsed.subject ?? '', from: parsed.from?.address ?? '', date: null },
  }
}

describe.skipIf(!bocAvailable)('Case A - real Bank of China PDF', () => {
  it('parses, balances and keeps column directions', async () => {
    const doc = await loadPdfSource(bocPath)
    expect(bocParser.match(doc)).toBeGreaterThan(0.5)

    const parsed = bocParser.parse(doc)
    const { summary } = parsed

    expect(summary.previousBalanceMinor).not.toBeNull()
    expect(summary.newDebitMinor).not.toBeNull()
    expect(summary.newCreditMinor).not.toBeNull()
    expect(summary.currentBalanceMinor).not.toBeNull()

    // 本期余额 = 上期余额 + 本期支出 − 本期存入
    const computed =
      summary.previousBalanceMinor! + summary.newDebitMinor! - summary.newCreditMinor!
    expect(computed).toBe(summary.currentBalanceMinor)

    const result = reconcileStatement({
      summary,
      transactions: parsed.transactions.map((tx, index) => ({
        id: `t${index}`,
        statementId: 'x',
        bank: parsed.bank,
        cardLast4: tx.cardLast4,
        transactionDate: tx.transactionDate,
        postingDate: tx.postingDate,
        description: tx.description,
        rawDescription: tx.rawDescription,
        merchant: tx.merchant,
        transactionCurrency: tx.transactionCurrency,
        transactionAmountMinor: tx.transactionAmountMinor,
        settlementCurrency: tx.settlementCurrency,
        settlementAmountMinor: tx.settlementAmountMinor,
        type: tx.type,
        direction: tx.direction,
        category: '未分类',
        confidence: tx.confidence,
        flags: [],
        reviewStatus: 'ok',
        sourceFileName: doc.fileName,
        sourceFileHash: doc.fileHash,
        sourcePage: tx.sourcePage,
        sourceRow: tx.sourceRow,
        rawText: tx.rawText,
        fingerprint: `f${index}`,
        occurrence: 1,
        isDemo: false,
      })),
    })

    // eslint-disable-next-line no-console
    console.log('[BOC]', parsed.transactions.length, 'tx', parsed.transactions.map((t) => `${t.transactionDate}/${t.direction}/${formatMinor(t.settlementAmountMinor)}/${t.description}`))
    // eslint-disable-next-line no-console
    console.log('[BOC] reconciliation', JSON.stringify(result.checks, null, 2))

    expect(result.status).toBe('passed')
    expect(result.checks.filter((check) => check.status === 'mismatch')).toHaveLength(0)
  })
})

describe.skipIf(!bocomAvailable)('Case B - real Bank of Communications EML', () => {
  it('decodes GBK HTML, resolves the cycle and balances', async () => {
    const doc = await loadEmlSource(bocomPath)
    expect(bocomParser.match(doc)).toBeGreaterThan(0.5)

    const parsed = bocomParser.parse(doc)
    const { summary } = parsed

    expect(parsed.cardLast4).toMatch(/^\d{4}$/)
    expect(parsed.cycleStart).not.toBeNull()
    expect(parsed.cycleEnd).not.toBeNull()

    // Every transaction must sit inside the reported cycle.
    for (const tx of parsed.transactions) {
      if (!tx.transactionDate) continue
      expect(tx.transactionDate >= parsed.cycleStart!).toBe(true)
      expect(tx.transactionDate <= parsed.cycleEnd!).toBe(true)
    }

    // Original installment purchases must never be counted as new spending.
    for (const tx of parsed.transactions) {
      if (tx.type !== 'installment_original') continue
      expect(tx.direction).toBe('debit')
    }

    const credits = parsed.transactions
      .filter((tx) => tx.direction === 'credit')
      .reduce((sum, tx) => sum - tx.settlementAmountMinor, 0)
    expect(credits).toBe(summary.newCreditMinor)

    const computed =
      summary.previousBalanceMinor! +
      summary.newDebitMinor! +
      (summary.chargeMinor ?? 0) +
      (summary.interestMinor ?? 0) -
      summary.newCreditMinor!
    expect(computed).toBe(summary.currentBalanceMinor)

    const result = reconcileStatement({
      summary,
      transactions: parsed.transactions.map(toTransaction),
    })
    // eslint-disable-next-line no-console
    console.log('[BOCOM]', parsed.transactions.length, 'tx', 'cycle', parsed.cycleStart, '->', parsed.cycleEnd)
    // eslint-disable-next-line no-console
    console.log('[BOCOM] reconciliation', JSON.stringify(result.checks, null, 2))
    expect(result.status).toBe('passed')
    expect(result.checks.filter((check) => check.status === 'mismatch')).toHaveLength(0)
  })
})

function toTransaction(tx: {
  cardLast4: string
  transactionDate: string | null
  postingDate: string | null
  description: string
  rawDescription: string
  merchant: string
  transactionCurrency: string
  transactionAmountMinor: number
  settlementCurrency: string
  settlementAmountMinor: number
  type: Transaction['type']
  direction: Transaction['direction']
  confidence: number
  sourcePage: number | null
  sourceRow: number
  rawText: string
}): Transaction {
  return {
    id: `t${Math.abs(hash(JSON.stringify(tx)))}`,
    statementId: 'acceptance',
    bank: 'bocom',
    cardLast4: tx.cardLast4,
    transactionDate: tx.transactionDate,
    postingDate: tx.postingDate,
    description: tx.description,
    rawDescription: tx.rawDescription,
    merchant: tx.merchant,
    transactionCurrency: tx.transactionCurrency,
    transactionAmountMinor: tx.transactionAmountMinor,
    settlementCurrency: tx.settlementCurrency,
    settlementAmountMinor: tx.settlementAmountMinor,
    type: tx.type,
    direction: tx.direction,
    category: '未分类',
    confidence: tx.confidence,
    flags: [],
    reviewStatus: 'ok',
    sourceFileName: 'acceptance',
    sourceFileHash: 'acceptance',
    sourcePage: tx.sourcePage,
    sourceRow: tx.sourceRow,
    rawText: tx.rawText,
    fingerprint: 'f',
    occurrence: 1,
    isDemo: false,
  }
}

function hash(text: string): number {
  let value = 0
  for (let i = 0; i < text.length; i++) value = (value * 31 + text.charCodeAt(i)) | 0
  return value
}