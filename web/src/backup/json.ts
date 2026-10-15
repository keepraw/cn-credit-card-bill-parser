import { MAX_JSON_BYTES, readBlobBytes } from './zipSafety'

export const MAX_JSON_DEPTH = 64
export const MAX_JSON_TOKENS = 8_000_000
export const MAX_JSON_CONTAINERS = 2_000_000

/** Resource preflight only; JSON.parse and record validation remain authoritative. */
class JsonBudget {
  private depth = 0
  private containers = 0
  private tokens = 0
  private quoted = false
  private escaped = false
  private primitive = false

  consume(text: string): void {
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i)
      if (this.quoted) {
        if (this.escaped) this.escaped = false
        else if (c === 92) this.escaped = true
        else if (c === 34) this.quoted = false
        continue
      }
      if (c === 34) { this.quoted = true; this.tokens++; this.primitive = false }
      else if (c === 123 || c === 91) {
        this.depth++; this.containers++; this.tokens++; this.primitive = false
      } else if (c === 125 || c === 93) { this.depth--; this.primitive = false }
      else if (c === 44 || c === 58 || c <= 32) this.primitive = false
      else if (!this.primitive) { this.tokens++; this.primitive = true }
      if (this.depth > MAX_JSON_DEPTH || this.depth < 0 || this.containers > MAX_JSON_CONTAINERS || this.tokens > MAX_JSON_TOKENS) {
        throw new Error('备份 JSON 结构过大或嵌套过深')
      }
    }
  }

  finish(): void {
    if (this.quoted || this.depth !== 0) throw new Error('备份 JSON 格式错误')
  }
}

/** Compact v1 JSON, encoded in bounded chunks, without a ledger-sized JS string. */
export function createJsonBlob(value: object, limit = MAX_JSON_BYTES): Blob {
  const parts: BlobPart[] = []
  const encoder = new TextEncoder()
  const budget = new JsonBudget()
  let pending = '', size = 0
  const flush = () => {
    budget.consume(pending)
    const bytes = encoder.encode(pending)
    size += bytes.byteLength
    if (size > limit) throw new Error('备份 JSON 文件过大')
    parts.push(bytes)
    pending = ''
  }
  const append = (text: string) => {
    // UTF-8 cannot need fewer bytes than JS code units for JSON text.
    if (size + pending.length + text.length > limit) throw new Error('备份 JSON 文件过大')
    pending += text
    if (pending.length >= 64 * 1024) flush()
  }
  append('{')
  let first = true
  for (const [key, field] of Object.entries(value)) {
    if (field === undefined) continue
    append(`${first ? '' : ','}${JSON.stringify(key)}:`)
    first = false
    if (Array.isArray(field)) {
      append('[')
      for (let i = 0; i < field.length; i++) append(`${i ? ',' : ''}${JSON.stringify(field[i]) ?? 'null'}`)
      append(']')
    } else append(JSON.stringify(field))
  }
  append('}')
  flush()
  budget.finish()
  return new Blob(parts, { type: 'application/json' })
}

export function parseJsonBytes(bytes: ArrayBuffer): unknown {
  if (bytes.byteLength > MAX_JSON_BYTES) throw new Error('备份 JSON 文件过大')
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  const budget = new JsonBudget()
  budget.consume(text)
  budget.finish()
  return JSON.parse(text) as unknown
}

export async function readJsonBackup(file: Blob): Promise<unknown> {
  return parseJsonBytes(await readBlobBytes(file, MAX_JSON_BYTES, '备份 JSON 文件过大'))
}
