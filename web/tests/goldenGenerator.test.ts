import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { expect, it } from 'vitest'
import { SYNTHETIC_CCB_HTML } from './fixtures/ccbEml'

it('runs the TypeScript Golden generator on a synthetic source without Python', () => {
  const dir = mkdtempSync(join(tmpdir(), 'keepraw-golden-generator-'))
  try {
    const input = join(dir, 'synthetic.html')
    const out = join(dir, 'output')
    writeFileSync(input, SYNTHETIC_CCB_HTML)
    execFileSync(process.execPath, ['scripts/generate-golden.mjs', '--input', input, '--out', out], { encoding: 'utf8' })
    const doc = JSON.parse(readFileSync(join(out, 'web.json'), 'utf8'))
    expect(doc.schema).toBe('golden/v1')
    expect(doc.origin).toBe('web')
    expect(doc.bank).toBe('ccb')
    expect(doc.desensitized).toBe(true)
    expect(doc.transactionCount).toBe(14)
    expect(doc.transactions).toHaveLength(14)
    expect(readFileSync(input, 'utf8')).toBe(SYNTHETIC_CCB_HTML)
  } finally { rmSync(dir, { recursive: true, force: true }) }
}, 30_000)
