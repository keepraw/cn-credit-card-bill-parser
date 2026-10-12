/**
 * Minimal XLSX reading for Legacy Import.
 *
 * Dates are intentionally read as raw serials/strings (no `cellDates`):
 * every date cell goes through the adapter's own guarded parser, so a
 * local-timezone Date can never silently shift a transaction by one day.
 */

export interface SheetData {
  /** All sheet names in workbook order. */
  sheetNames: string[]
  /** Raw rows of the requested sheet, header first. Empty when absent. */
  rows: unknown[][]
}

export async function readSheetData(buffer: ArrayBuffer, sheetName: string): Promise<SheetData> {
  const XLSX = await import('xlsx')
  const workbook = XLSX.read(buffer, { type: 'array' })
  const sheetNames: string[] = workbook.SheetNames ?? []
  const sheet = workbook.Sheets[sheetName]
  if (!sheet) return { sheetNames, rows: [] }
  const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, raw: true, defval: null }) as unknown[][]
  return { sheetNames, rows: Array.isArray(rows) ? rows : [] }
}
