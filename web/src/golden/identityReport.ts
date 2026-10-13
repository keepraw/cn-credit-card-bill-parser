/**
 * Observation-only identity mapping (Task A-3.4.6).
 *
 * Reports which business keys pair across pipelines. Never merges anything.
 */

import type { IdentityEntry, NormalizedTransaction } from './schema'

export function businessKeyOf(tx: Pick<NormalizedTransaction, 'transactionDate' | 'postingDate' | 'amountMinor' | 'currency'>): string {
  return [tx.transactionDate, tx.postingDate, String(tx.amountMinor), tx.currency].join('|')
}

export interface Pairing {
  pairs: Array<[number, number]>
  pythonUnpaired: number[]
  webUnpaired: number[]
}

/** Stable multiset alignment on the business key, order-preserving within a key. */
export function alignTransactions(python: NormalizedTransaction[], web: NormalizedTransaction[]): Pairing {
  const buckets = new Map<string, number[]>()
  web.forEach((tx, index) => {
    const key = businessKeyOf(tx)
    const bucket = buckets.get(key) ?? []
    bucket.push(index)
    buckets.set(key, bucket)
  })
  const used = new Set<number>()
  const pairs: Array<[number, number]> = []
  const pythonUnpaired: number[] = []
  python.forEach((tx, pIndex) => {
    const bucket = buckets.get(businessKeyOf(tx)) ?? []
    const match = bucket.find((i) => !used.has(i))
    if (match === undefined) pythonUnpaired.push(pIndex)
    else {
      used.add(match)
      pairs.push([pIndex, match])
    }
  })
  const webUnpaired = web.map((_, i) => i).filter((i) => !used.has(i))
  return { pairs, pythonUnpaired, webUnpaired }
}

const P0_FIELDS: Array<'bank' | 'cardLast4' | 'transactionDate' | 'postingDate' | 'amountMinor' | 'currency' | 'direction'> = [
  'bank',
  'cardLast4',
  'transactionDate',
  'postingDate',
  'amountMinor',
  'currency',
  'direction',
]

/** Do not modify identity. Only observe pairing; every entry has merged: false. */
export function buildIdentityEntries(
  python: NormalizedTransaction[],
  web: NormalizedTransaction[],
  pairing: Pairing,
): IdentityEntry[] {
  const entries: IdentityEntry[] = []
  for (const [pIndex, wIndex] of pairing.pairs) {
    const p = python[pIndex]!
    const w = web[wIndex]!
    const full = P0_FIELDS.every((field) => p[field] === w[field])
    entries.push({
      businessKey: businessKeyOf(p),
      pythonNativeId: p.nativeId || null,
      webNativeId: w.nativeId || null,
      match: full ? 'full' : 'partial',
      merged: false,
    })
  }
  for (const pIndex of pairing.pythonUnpaired) {
    const p = python[pIndex]!
    entries.push({ businessKey: businessKeyOf(p), pythonNativeId: p.nativeId || null, webNativeId: null, match: 'unpaired', merged: false })
  }
  for (const wIndex of pairing.webUnpaired) {
    const w = web[wIndex]!
    entries.push({ businessKey: businessKeyOf(w), pythonNativeId: null, webNativeId: w.nativeId || null, match: 'unpaired', merged: false })
  }
  return entries
}
