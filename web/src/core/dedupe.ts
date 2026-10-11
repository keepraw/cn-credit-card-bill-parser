import type { ReviewFlag, Transaction } from './types'

/**
 * Duplicate handling.
 *
 * Four situations that must NOT be conflated:
 *
 *   1. the same file imported twice          -> the file hash short-circuits everything
 *   2. the same statement from another file  -> per-transaction fingerprint merge
 *   3. genuinely repeated purchases          -> the occurrence index keeps each one
 *   4. same day/amount but different wording -> flagged for review, never merged
 *
 * Nothing is ever silently deleted.
 */

export interface OccurrenceAssignment {
  fingerprint: string
  occurrence: number
}

/**
 * Identical rows inside one statement keep their own identity: the first keeps the
 * bare fingerprint, the second gets suffix `#2`, and so on.
 */
export function assignOccurrences(fingerprints: string[]): OccurrenceAssignment[] {
  const counters = new Map<string, number>()
  return fingerprints.map((fingerprint) => {
    const occurrence = (counters.get(fingerprint) ?? 0) + 1
    counters.set(fingerprint, occurrence)
    return { fingerprint, occurrence }
  })
}

export function transactionId(fingerprint: string, occurrence: number): string {
  return occurrence <= 1 ? fingerprint : `${fingerprint}#${occurrence}`
}

export function parseTransactionId(id: string): { fingerprint: string; occurrence: number } {
  const match = /^(.*)#(\d+)$/.exec(id)
  if (!match) return { fingerprint: id, occurrence: 1 }
  return { fingerprint: match[1]!, occurrence: Number(match[2]) }
}

export interface DuplicateOutcome {
  /** Incoming transaction ids already present in storage. */
  duplicateIds: Set<string>
  /** Incoming transaction ids flagged as *likely* duplicates with a differing description. */
  suspectedDuplicates: Map<string, string[]>
}

interface FingerprintView {
  fingerprint: string
  transactionDate: string | null
  settlementAmountMinor: number
  type: string
  description: string
}

/**
 * Compare freshly parsed transactions with what is already stored.
 *
 * Exact identity is `fingerprint + occurrence`. A looser key (bank/card/date/amount/
 * type) is only used to raise `suspected_duplicate` for human review.
 */
export function detectDuplicates(
  incoming: Array<{ id: string } & FingerprintView>,
  existing: FingerprintView[],
): DuplicateOutcome {
  const duplicateIds = new Set<string>()
  const suspectedDuplicates = new Map<string, string[]>()

  const exact = new Map<string, FingerprintView[]>()
  for (const row of existing) {
    const bucket = exact.get(row.fingerprint) ?? []
    bucket.push(row)
    exact.set(row.fingerprint, bucket)
  }

  const loose = new Map<string, FingerprintView[]>()
  for (const row of existing) {
    const key = looseKey(row)
    const bucket = loose.get(key) ?? []
    bucket.push(row)
    loose.set(key, bucket)
  }

  for (const row of incoming) {
    const exactBucket = exact.get(row.fingerprint) ?? []
    if (exactBucket.some((candidate) => candidate.description === row.description)) {
      duplicateIds.add(row.id)
    }
    const looseBucket = loose.get(looseKey(row)) ?? []
    const others = looseBucket.filter((candidate) => candidate.description !== row.description)
    if (others.length > 0) suspectedDuplicates.set(row.id, others.map((candidate) => candidate.description))
  }

  return { duplicateIds, suspectedDuplicates }
}

function looseKey(row: FingerprintView): string {
  return [row.fingerprint.slice(0, 8), row.transactionDate ?? '', String(row.settlementAmountMinor), row.type].join('|')
}

/** Transactions of one statement that share bank/card/date/amount but differ in text. */
export function findSuspectedDuplicateGroups(transactions: Transaction[]): Map<string, string[]> {
  const groups = new Map<string, Transaction[]>()
  for (const tx of transactions) {
    const key = [tx.bank, tx.cardLast4, tx.transactionDate ?? '', String(tx.settlementAmountMinor), tx.type].join('|')
    const bucket = groups.get(key) ?? []
    bucket.push(tx)
    groups.set(key, bucket)
  }

  const result = new Map<string, string[]>()
  for (const [, bucket] of groups) {
    if (bucket.length < 2) continue
    const distinct = new Set(bucket.map((tx) => tx.description))
    if (distinct.size < 2) continue
    for (const tx of bucket) {
      result.set(
        tx.id,
        bucket.filter((other) => other.id !== tx.id).map((other) => other.description),
      )
    }
  }
  return result
}

export function addFlag(transaction: Transaction, flag: ReviewFlag): Transaction {
  if (transaction.flags.includes(flag)) return transaction
  return { ...transaction, flags: [...transaction.flags, flag] }
}