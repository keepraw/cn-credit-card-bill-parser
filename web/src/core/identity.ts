/**
 * Transaction identity.
 *
 * A fingerprint describes "what the statement says happened". Identical rows inside
 * one statement get an occurrence index so real repeated purchases (same day, same
 * merchant, same amount) are never collapsed into one. Across files the same
 * fingerprint means the same transaction and is de-duplicated.
 */

/** FNV-1a 64-bit style hash (two 32-bit lanes) rendered as hex. Stable across runs. */
export function stableHash(...parts: string[]): string {
  let h1 = 0x811c9dc5
  let h2 = 0x01000193
  const input = parts.join('\u0001')
  for (let i = 0; i < input.length; i++) {
    const code = input.charCodeAt(i)
    h1 ^= code
    h1 = Math.imul(h1, 0x01000193) >>> 0
    h2 = (h2 + Math.imul(code + i, 0x85ebca6b)) >>> 0
    h2 = ((h2 << 13) | (h2 >>> 19)) >>> 0
  }
  return `${h1.toString(16).padStart(8, '0')}${h2.toString(16).padStart(8, '0')}`
}

export function statementKey(bank: string, cardLast4: string, cycleStart: string | null, cycleEnd: string | null): string {
  return stableHash('stmt', bank, cardLast4, cycleStart ?? '', cycleEnd ?? '')
}

const VOLATILE_MARKERS = /\b(?:CHN|CR|DR|CNY|RMB|USD|HKD)\b/gi

/** Remove currency markers and collapse whitespace so the same merchant compares equal. */
export function normalizeDescription(text: string): string {
  return (text ?? '')
    .replace(VOLATILE_MARKERS, '')
    .replace(/[（(].*?[）)]/g, '')
    .replace(/[\s\u00a0]+/g, '')
    .replace(/[-_·、,，.。/\\]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase()
}

export interface FingerprintInput {
  bank: string
  cardLast4: string
  transactionDate: string | null
  postingDate: string | null
  settlementCurrency: string
  settlementAmountMinor: number
  type: string
  description: string
}

export function transactionFingerprint(input: FingerprintInput): string {
  return stableHash(
    'txn',
    input.bank,
    input.cardLast4,
    input.transactionDate ?? '',
    input.postingDate ?? '',
    input.settlementCurrency,
    String(input.settlementAmountMinor),
    input.type,
    normalizeDescription(input.description),
  )
}

/** Loose key used only to *flag* likely duplicates - never to delete anything. */
export function suspectedDuplicateKey(input: FingerprintInput): string {
  return stableHash(
    'loose',
    input.bank,
    input.cardLast4,
    input.transactionDate ?? '',
    String(input.settlementAmountMinor),
    input.type,
  )
}

export function looseDescription(input: FingerprintInput): string {
  return normalizeDescription(input.description)
}