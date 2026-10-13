/** Read-only business-field observations. Native IDs are labels, never matching keys. */
export interface MigrationRow {
  id?: string
  sourceRow?: number
  bank: string
  cardLast4: string
  transactionDate: string | null
  postingDate?: string | null
  settlementCurrency?: string
  settlementAmountMinor: number
  transactionCurrency?: string
  transactionAmountMinor?: number
  type: string
  direction?: string
  description: string
}

const COMPARED_FIELDS = [
  'postingDate', 'description', 'type', 'direction', 'transactionCurrency', 'transactionAmountMinor',
] as const

function scopeKey(row: MigrationRow): string | null {
  if (row.bank === 'unknown' || !row.cardLast4 || row.cardLast4 === '????' || !row.transactionDate) return null
  return JSON.stringify([row.bank, row.cardLast4, row.transactionDate, row.settlementCurrency, row.settlementAmountMinor])
}

function fullKey(row: MigrationRow): string {
  return JSON.stringify([scopeKey(row), ...COMPARED_FIELDS.map((field) => row[field])])
}

export interface MigrationObservation {
  incomingId: string | null
  sourceRow: number | null
  status: 'exact_candidate' | 'review' | 'unmatched'
  /** Bounded examples; candidateCount reports the full bucket size. */
  candidateIds: string[]
  candidateCount: number
  differingFields: string[]
}

export interface MigrationAudit {
  schema: 'migration-audit/v1'
  merged: false
  exactCandidates: number
  reviewCandidates: number
  unmatched: number
  observations: MigrationObservation[]
}

/**
 * Consume exact business occurrences one-to-one; ambiguous scope matches only
 * request review. Output cannot authorize a merge, deletion or ID rewrite.
 * Desensitized golden descriptions must not be compared with raw export text.
 */
export function auditMigrationRows(incoming: MigrationRow[], existing: MigrationRow[]): MigrationAudit {
  const exact = new Map<string, MigrationRow[]>()
  const loose = new Map<string, { count: number; examples: MigrationRow[] }>()
  for (const row of existing) {
    const scope = scopeKey(row)
    if (scope === null) continue
    const key = fullKey(row)
    const matches = exact.get(key) ?? []
    matches.push(row)
    exact.set(key, matches)
    const bucket = loose.get(scope) ?? { count: 0, examples: [] }
    bucket.count += 1
    // Three signatures suffice for bounded review examples, without scanning
    // huge same-day buckets per incoming row.
    if (bucket.examples.length < 3 && !bucket.examples.some((other) => fullKey(other) === key)) bucket.examples.push(row)
    loose.set(scope, bucket)
  }
  const cursors = new Map<string, number>()
  const observations: MigrationObservation[] = incoming.map((row) => {
    const scope = scopeKey(row)
    const key = fullKey(row)
    const cursor = cursors.get(key) ?? 0
    const matches = scope === null ? undefined : exact.get(key)
    const match = matches?.[cursor]
    if (match) {
      cursors.set(key, cursor + 1)
      return { incomingId: row.id ?? null, sourceRow: row.sourceRow ?? null, status: 'exact_candidate',
        candidateIds: match.id ? [match.id] : [], candidateCount: matches!.length, differingFields: [] }
    }
    const bucket = scope === null ? undefined : loose.get(scope)
    const peers = bucket?.examples.filter((other) => fullKey(other) !== key) ?? []
    return {
      incomingId: row.id ?? null, sourceRow: row.sourceRow ?? null, status: peers.length > 0 ? 'review' : 'unmatched',
      candidateIds: peers.flatMap((peer) => peer.id ? [peer.id] : []), candidateCount: bucket?.count ?? 0,
      differingFields: COMPARED_FIELDS.filter((field) => peers.some((peer) => peer[field] !== row[field])),
    }
  })
  return { schema: 'migration-audit/v1', merged: false,
    exactCandidates: observations.filter((row) => row.status === 'exact_candidate').length,
    reviewCandidates: observations.filter((row) => row.status === 'review').length,
    unmatched: observations.filter((row) => row.status === 'unmatched').length, observations }
}
