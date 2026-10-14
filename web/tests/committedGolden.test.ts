import { createHash } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseDateInput } from '../src/core/dates'
import { normalizeDescription } from '../src/core/identity'
import { diffGolden } from '../src/golden/diff'
import { GOLDEN_SCHEMA, type DiffReport, type GoldenStatement } from '../src/golden/schema'

const ROOT = resolve('../golden')
// Immutable references audited at main 8b192875. These are not parser-generated expectations.
const BASELINES = {
  boc: { count: 4, warnings: 1, digest: '692f98ba2007f9728ab207c8032ef40c81dfdc6e816837aeff0fe541b1ad43df' },
  icbc: { count: 7, warnings: 7, digest: 'a90719dc9331ffed945e22f0674ce1253b9b02b4e231a3e33498b0669bf81aab' },
  abc: { count: 15, warnings: 0, digest: 'd460179b845b7ce3549e8cba1ec167e38af8bdf6b19697ee4dc50fb47c3262e6' },
  ccb: { count: 5, warnings: 0, digest: '9059006eb07ec471a5caa26344392b667b000f70d34d92813fb2042c482e50a7' },
  bocom: { count: 23, warnings: 0, digest: '5deb787f44733fa775a391247399c9d5891f4e41c49ab3bfa2ad317b1a4066e0' },
  citic: { count: 12, warnings: 0, digest: '83e2a728609d460cccf809205ae22bc6d90817b6561c1e874dad1eec3b6b58d6' },
} as const

function assertDate(value: unknown) {
  expect(typeof value).toBe('string')
  expect(value).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  expect(parseDateInput(value as string)).toBe(value)
}

function assertStatement(value: unknown, origin: 'python' | 'web', bank: string, count: number): asserts value is GoldenStatement {
  expect(value).toBeTypeOf('object')
  expect(value).not.toBeNull()
  const doc = value as GoldenStatement
  expect(doc.schema).toBe(GOLDEN_SCHEMA)
  expect(doc.origin).toBe(origin)
  expect(doc.bank).toBe(bank)
  expect(doc.desensitized).toBe(true)
  for (const field of ['generator', 'bankNative', 'parserName'] as const) expect(doc[field]).toBeTypeOf('string')
  for (const field of ['generator', 'bankNative', 'parserName'] as const) expect(doc[field].length).toBeGreaterThan(0)
  expect(doc.cardLast4).toMatch(/^\d{4}$/)
  assertDate(doc.cycleStart)
  assertDate(doc.cycleEnd)
  expect(doc.cycleStart! <= doc.cycleEnd!).toBe(true)
  expect(doc.nativeIds).toBeTypeOf('object')
  expect(Object.keys(doc.nativeIds).length).toBeGreaterThan(0)
  for (const entry of Object.values(doc.nativeIds)) expect(entry).toBeTypeOf('string')
  expect(doc.transactionCount).toBe(count)
  expect(Array.isArray(doc.transactions)).toBe(true)
  expect(doc.transactions).toHaveLength(count)
  expect(new Set(doc.transactions.map((row) => row.nativeId)).size).toBe(count)
  for (const row of doc.transactions) {
    expect(row.bank).toBe(bank)
    expect(row.cardLast4).toMatch(/^\d{4}$/)
    assertDate(row.transactionDate)
    assertDate(row.postingDate)
    expect(Number.isSafeInteger(row.amountMinor)).toBe(true)
    expect(row.currency).toMatch(/^[A-Z]{3}$/)
    expect(row.direction).toBe(row.amountMinor < 0 ? 'credit' : 'debit')
    for (const field of ['description', 'normalizedDescription', 'nativeId', 'statementKey'] as const) {
      expect(row[field]).toBeTypeOf('string')
      expect(row[field].length).toBeGreaterThan(0)
    }
    expect(row.normalizedDescription).toBe(normalizeDescription(row.description))
    expect(row.nativeId).toMatch(origin === 'python' ? /^[0-9a-f]{64}$/ : /^[0-9a-f]{16}(?:#\d+)?$/)
    expect(row.statementKey).toMatch(origin === 'python' ? /^[0-9a-f]{64}$/ : new RegExp(`^${bank}:`))
    expect(row.rawText).toBeTypeOf('string')
    expect(row.sourcePosition).toBeTypeOf('object')
    expect(row.sourcePosition).not.toBeNull()
    for (const position of Object.values(row.sourcePosition)) {
      expect(position === null || typeof position === 'string' || Number.isInteger(position)).toBe(true)
    }
  }
}

function multiplicities(doc: GoldenStatement) {
  const result = new Map<string, number>()
  for (const row of doc.transactions) {
    const key = JSON.stringify([row.bank, row.cardLast4, row.transactionDate, row.postingDate, row.amountMinor, row.currency, row.direction])
    result.set(key, (result.get(key) ?? 0) + 1)
  }
  return result
}

describe('committed historical Golden references without Python', () => {
  it('covers exactly six banks, six statements and 66 transactions', () => {
    expect(readdirSync(ROOT, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort())
      .toEqual(Object.keys(BASELINES).sort())
    expect(Object.values(BASELINES).reduce((sum, item) => sum + item.count, 0)).toBe(66)
  })

  for (const [bank, baseline] of Object.entries(BASELINES)) {
    it(`${bank}: validates schema, multiplicity, P0 fields, identity and approved warnings`, () => {
      const directories = readdirSync(`${ROOT}/${bank}`, { withFileTypes: true }).filter((entry) => entry.isDirectory())
      expect(directories).toHaveLength(1)
      const dir = `${ROOT}/${bank}/${directories[0]!.name}`
      const files = ['input.meta.json', 'python.json', 'web.json', 'diff.json'].map((name) => readFileSync(`${dir}/${name}`, 'utf8'))
      expect(createHash('sha256').update(files.join('')).digest('hex')).toBe(baseline.digest)
      const [meta, python, web, saved] = files.map((content) => JSON.parse(content))
      expect(meta.schema).toBe(GOLDEN_SCHEMA)
      expect(meta.bank).toBe(bank)
      expect(meta.desensitized).toBe(true)
      expect(meta.sha256).toMatch(/^[0-9a-f]{64}$/)
      expect(Number.isSafeInteger(meta.fileSize) && meta.fileSize > 0).toBe(true)
      for (const field of ['fileName', 'sourceType', 'bankNative', 'parserName', 'generator', 'note']) {
        expect(meta[field]).toBeTypeOf('string')
        expect(meta[field].length).toBeGreaterThan(0)
      }
      expect(meta.cardLast4).toMatch(/^\d{4}$/)
      assertDate(meta.cycleStart)
      assertDate(meta.cycleEnd)
      expect(meta.transactionCount).toBe(baseline.count)
      assertStatement(python, 'python', bank, baseline.count)
      assertStatement(web, 'web', bank, baseline.count)
      for (const doc of [python, web]) {
        expect(doc.cardLast4).toBe(meta.cardLast4)
        expect(doc.cycleStart).toBe(meta.cycleStart)
        expect(doc.cycleEnd).toBe(meta.cycleEnd)
      }
      expect(multiplicities(python)).toEqual(multiplicities(web))
      const recomputed = diffGolden(python, web, saved.generator)
      expect(recomputed).toEqual(saved as DiffReport)
      expect(recomputed.pairedRows).toBe(baseline.count)
      expect(recomputed.verdict).toBe(baseline.warnings ? 'WARNING' : 'PASS')
      expect(recomputed.severityCounts).toEqual({ BLOCKING: 0, WARNING: baseline.warnings, INFO: 0 })
      expect(recomputed.findings.every((finding) => finding.rule === 'description' && finding.severity === 'WARNING')).toBe(true)
      expect(recomputed.identity.compatible).toBe(false)
      expect(recomputed.identity.merged).toBe(false)
      expect(recomputed.identity.entries).toHaveLength(baseline.count)
      expect(recomputed.identity.entries.every((entry) => entry.match === 'full' && entry.merged === false)).toBe(true)
    })
  }
})
