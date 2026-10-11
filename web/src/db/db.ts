import Dexie, { type Table } from 'dexie'
import type { AppSettings, ImportRecord, Statement, Transaction } from '../core/types'

export interface SettingRow {
  key: string
  value: unknown
}

export interface ReviewNoteRow {
  transactionId: string
  note: string
  updatedAt: string
}

export const DEFAULT_SETTINGS: AppSettings = {
  theme: 'system',
  demoMode: false,
  locale: 'zh-CN',
}

/**
 * Browser-local storage. Nothing here ever leaves the device: there is no network
 * call anywhere in this application.
 */
export class BillDatabase extends Dexie {
  statements!: Table<Statement, string>
  transactions!: Table<Transaction, string>
  imports!: Table<ImportRecord, string>
  settings!: Table<SettingRow, string>
  reviewNotes!: Table<ReviewNoteRow, string>

  constructor(name = 'credit-bill-manager') {
    super(name)
    this.version(1).stores({
      statements: 'id, bank, cardLast4, cycleEnd, status, isDemo',
      transactions:
        'id, statementId, bank, transactionDate, postingDate, type, category, reviewStatus, isDemo, fingerprint, [bank+transactionDate]',
      imports: 'id, fileHash, importedAt, status, isDemo',
      settings: 'key',
      reviewNotes: 'transactionId',
    })
  }
}

export const db = new BillDatabase()

export async function loadSettings(): Promise<AppSettings> {
  const row = await db.settings.get('app')
  return { ...DEFAULT_SETTINGS, ...((row?.value as Partial<AppSettings>) ?? {}) }
}

export async function saveSettings(settings: AppSettings): Promise<void> {
  await db.settings.put({ key: 'app', value: settings })
}