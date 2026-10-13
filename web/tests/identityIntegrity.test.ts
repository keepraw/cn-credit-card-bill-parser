import { beforeEach, describe, expect, it } from 'vitest'
import { db } from '../src/db/db'
import { persistImportResults, readSnapshot } from '../src/db/repository'
import { detectDuplicates } from '../src/core/dedupe'
import { normalizeDescription } from '../src/core/identity'
import { ingestSynthetic, syntheticStatement, EMPTY_SNAPSHOT } from './fixtures/identity'
import { ingestParsedStatement } from '../src/core/ingest'
import { failedImportRecord } from '../src/core/ingest'

beforeEach(async () => {
  await db.delete()
  await db.open()
})

describe('occurrence and identity integrity', () => {
  it.each([[1, 2, 2], [2, 3, 3], [2, 1, 2]])(
    'preserves max occurrence count: stored %i, incoming %i, final %i', async (stored, incoming, final) => {
      await persistImportResults([ingestSynthetic(Array(stored).fill('消费 示例商户'), 'first')])
      const snapshot = await readSnapshot()
      const result = ingestSynthetic(Array(incoming).fill('消费 示例商户'), 'overlap', snapshot)
      expect(result.inserted).toHaveLength(Math.max(0, incoming - stored))
      await persistImportResults([result])
      expect(await db.transactions.count()).toBe(final)
    },
  )

  it('keeps normalized-description collisions distinct even when imported in reverse order', async () => {
    const a = '消费 商户(门店一)'
    const b = '消费 商户(门店二)'
    expect(normalizeDescription(a)).toBe(normalizeDescription(b))
    await persistImportResults([ingestSynthetic([a, b], 'first')])
    const snapshot = await readSnapshot()
    const ids = new Map(snapshot.transactions.map((tx) => [tx.description, tx.id]))
    const result = ingestSynthetic([b, a, a], 'overlap', snapshot)
    expect(result.inserted).toHaveLength(1)
    expect(result.inserted[0]!.id).not.toBe(ids.get(b))
    await persistImportResults([result])
    const rows = await db.transactions.toArray()
    expect(rows).toHaveLength(3)
    expect(rows.find((tx) => tx.id === ids.get(b))!.description).toBe(b)
    expect(rows.filter((tx) => tx.description === a)).toHaveLength(2)
  })

  it('does not overwrite an unrelated stored row with a colliding primary key', async () => {
    await persistImportResults([ingestSynthetic(['消费 商户(一)'], 'first')])
    const result = ingestSynthetic(['消费 商户(二)'], 'second', await readSnapshot())
    await persistImportResults([result])
    expect(await db.transactions.count()).toBe(2)
    expect(result.inserted[0]!.flags).toContain('suspected_duplicate')
  })

  it('preserves edited metadata on duplicate imports, including edits made after planning', async () => {
    await persistImportResults([ingestSynthetic(['消费 示例商户'], 'first')])
    const snapshot = await readSnapshot()
    const result = ingestSynthetic(['消费 示例商户'], 'second', snapshot)
    const edited = { ...snapshot.transactions[0]!, category: '旅行' as const, reviewStatus: 'confirmed' as const, flags: [] }
    await db.transactions.put(edited)
    await persistImportResults([result])
    expect(await db.transactions.get(edited.id)).toEqual(edited)
  })

  it('keeps an exact file re-import idempotent', async () => {
    await persistImportResults([ingestSynthetic(['消费 示例商户', '消费 示例商户'], 'same')])
    const result = ingestSynthetic(['消费 示例商户', '消费 示例商户'], 'same', await readSnapshot())
    expect(result.record.status).toBe('duplicate')
    expect(result.inserted).toHaveLength(0)
    await persistImportResults([result])
    expect(await db.transactions.count()).toBe(2)
  })

  it('skips a known file even after the stored description was edited', async () => {
    await persistImportResults([ingestSynthetic(['消费 示例商户'], 'same')])
    const stored = (await db.transactions.toArray())[0]!
    await db.transactions.put({ ...stored, description: '消费 用户修正商户' })
    const result = ingestSynthetic(['消费 示例商户'], 'same', await readSnapshot())
    expect(result.inserted).toHaveLength(0)
    await persistImportResults([result])
    expect(await db.transactions.count()).toBe(1)
    expect((await db.transactions.get(stored.id))!.description).toBe('消费 用户修正商户')
  })

  it('does not treat a previously failed file as a successful duplicate', () => {
    const failure = failedImportRecord({ fileName: 'synthetic.txt', fileHash: 'retry', fileSize: 1, sourceType: 'text' }, 'parser failed')
    const result = ingestSynthetic(['消费 示例商户'], 'retry', { ...EMPTY_SNAPSHOT, imports: [failure] })
    expect(result.record.status).not.toBe('duplicate')
    expect(result.inserted).toHaveLength(1)
  })

  it('does not merge different original-currency amounts with the same settlement amount', async () => {
    const first = ingestSynthetic(['消费 示例商户'], 'first')
    await persistImportResults([first])
    const parsed = syntheticStatement(['消费 示例商户'])
    parsed.transactions[0]!.transactionCurrency = 'USD'
    parsed.transactions[0]!.transactionAmountMinor = 1800
    const next = ingestParsedStatement(parsed, { fileName: 'foreign.txt', fileHash: 'foreign', fileSize: 1, sourceType: 'text' }, await readSnapshot())
    expect(next.inserted).toHaveLength(1)
    await persistImportResults([next])
    expect(await db.transactions.count()).toBe(2)
    const standalone = ingestParsedStatement(parsed, { fileName: 'foreign.txt', fileHash: 'foreign', fileSize: 1, sourceType: 'text' }, EMPTY_SNAPSHOT)
    expect(standalone.transactions[0]!.transactionAmountMinor).toBe(1800)
  })

  it('handles 100000 identical rows without collapsing additional occurrences', () => {
    const tx = ingestSynthetic(['消费 示例商户']).transactions[0]!
    const existing = Array.from({ length: 100_000 }, () => tx)
    const incoming = Array.from({ length: 100_001 }, (_, index) => ({ ...tx, id: `${tx.fingerprint}#${index + 1}` }))
    const started = performance.now()
    const result = detectDuplicates(incoming, existing)
    console.info(`dedupe smoke: existing=100000 incoming=100001 elapsed=${(performance.now() - started).toFixed(0)}ms`)
    expect(result.duplicateIds.size).toBe(100_000)
  }, 30_000)
})
