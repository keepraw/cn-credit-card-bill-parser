import { buildDemoDataset } from './demoData'
import type { Snapshot } from '../db/repository'

/**
 * In-memory demo dataset.
 *
 * Demo rows are fictional showcase data (cards `0000` / `9999`). They must
 * never be written to the production Dexie tables (`transactions`,
 * `statements`, `imports`, `attachments`): the provider serves this snapshot
 * directly while Demo Mode is on, and the real database stays untouched.
 * Built once per session; `buildDemoDataset` is deterministically seeded.
 */
let cached: Snapshot | null = null

export function getDemoSnapshot(): Snapshot {
  if (!cached) {
    const results = buildDemoDataset()
    cached = {
      statements: results.map((result) => result.statement!),
      transactions: results.flatMap((result) => result.transactions),
      imports: results.map((result) => result.record),
    }
  }
  return cached
}

/** Drop the cached snapshot (tests only). Production code never needs this. */
export function clearDemoCache(): void {
  cached = null
}
