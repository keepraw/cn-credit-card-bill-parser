/** Date helpers. All dates are handled as `YYYY-MM-DD` strings, never as local Date objects. */

export type IsoDate = string

const ISO_RE = /^\d{4}-\d{2}-\d{2}$/

export function isIsoDate(value: unknown): value is IsoDate {
  return typeof value === 'string' && ISO_RE.test(value) && !Number.isNaN(dayOfYearToDate(value))
}

function dayOfYearToDate(value: string): number {
  const [y, m, d] = value.split('-').map(Number) as [number, number, number]
  if (m < 1 || m > 12 || d < 1 || d > 31) return Number.NaN
  const date = new Date(Date.UTC(y, m - 1, d))
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return Number.NaN
  return date.getTime()
}

/** `2026-09-06`, `20260906`, `2026年9月6日`, `2026/9/6`, `09/06` (needs a year) -> ISO date. */
export function parseDateInput(raw: string, defaultYear?: number): IsoDate | null {
  if (!raw) return null
  const text = raw.trim().replace(/\s+/g, '')

  let m = /^(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})日?$/.exec(text)
  if (m) return buildIso(m[1], m[2], m[3])

  m = /^(\d{4})(\d{2})(\d{2})$/.exec(text)
  if (m) return buildIso(m[1], m[2], m[3])

  m = /^(\d{4})[-/.年](\d{1,2})月?$/.exec(text)
  if (m && defaultYear !== undefined) return monthEnd(defaultYear, Number(m[2]))

  m = /^(\d{1,2})[-/.](\d{1,2})$/.exec(text)
  if (m && defaultYear !== undefined) return buildIso(String(defaultYear), m[1], m[2])

  return null
}

function buildIso(year: string | undefined, month: string | undefined, day: string | undefined): IsoDate | null {
  if (!year || !month || !day) return null
  const iso = `${year.padStart(4, '0')}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`
  return isIsoDate(iso) ? iso : null
}

export function monthEnd(year: number, month: number): IsoDate {
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate()
  return `${year.toString().padStart(4, '0')}-${month.toString().padStart(2, '0')}-${last.toString().padStart(2, '0')}`
}

export function addDays(iso: IsoDate, days: number): IsoDate {
  const date = new Date(dayOfYearToDate(iso))
  date.setUTCDate(date.getUTCDate() + days)
  return date.toISOString().slice(0, 10)
}

export function addMonths(iso: IsoDate, months: number): IsoDate {
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number]
  const total = y * 12 + (m - 1) + months
  const ny = Math.floor(total / 12)
  const nm = (total % 12) + 1
  const lastDay = new Date(Date.UTC(ny, nm, 0)).getUTCDate()
  return `${ny.toString().padStart(4, '0')}-${nm.toString().padStart(2, '0')}-${Math.min(d, lastDay)
    .toString()
    .padStart(2, '0')}`
}

export function compareIso(a: IsoDate, b: IsoDate): number {
  return a < b ? -1 : a > b ? 1 : 0
}

export function isBetween(iso: IsoDate, start: IsoDate, end: IsoDate): boolean {
  return iso >= start && iso <= end
}

export function daysBetween(start: IsoDate, end: IsoDate): number {
  return Math.round((dayOfYearToDate(end) - dayOfYearToDate(start)) / 86_400_000)
}

export function monthKey(iso: IsoDate): string {
  return iso.slice(0, 7)
}

export function daysInMonth(monthKeyValue: string): number {
  const [y, m] = monthKeyValue.split('-').map(Number) as [number, number]
  return new Date(Date.UTC(y, m, 0)).getUTCDate()
}

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

export function formatDate(iso: IsoDate): string {
  if (!isIsoDate(iso)) return iso
  const date = new Date(dayOfYearToDate(iso))
  return `${iso.slice(5)} ${WEEKDAYS[date.getUTCDay()]}`
}

export function todayIso(): IsoDate {
  return new Date().toISOString().slice(0, 10)
}

/**
 * Resolve a `MM/DD` style short date inside a statement cycle.
 * Handles statements that cross a year boundary (e.g. 2026/08/15 - 2026/09/14).
 */
export function resolveShortDate(
  raw: string,
  cycleStart: IsoDate | null,
  cycleEnd: IsoDate | null,
  fallbackYear?: number,
): IsoDate | null {
  const match = /^(\d{1,2})[-/.](\d{1,2})$/.exec(raw.trim())
  if (!match) return parseDateInput(raw, fallbackYear)
  const month = Number(match[1])
  const day = Number(match[2])
  const candidateYears = new Set<number>()
  if (cycleStart) candidateYears.add(Number(cycleStart.slice(0, 4)))
  if (cycleEnd) candidateYears.add(Number(cycleEnd.slice(0, 4)))
  if (fallbackYear) candidateYears.add(fallbackYear)
  if (candidateYears.size === 0) return null

  const ordered = [...candidateYears].sort((a, b) => a - b)
  // Prefer a year whose candidate date falls inside the cycle.
  for (const year of ordered) {
    const candidate = buildIso(String(year), String(month), String(day))
    if (candidate && cycleStart && cycleEnd && isBetween(candidate, cycleStart, cycleEnd)) return candidate
  }
  // Otherwise use the cycle end year (a posting date may land just outside the cycle).
  const preferred = cycleEnd ? Number(cycleEnd.slice(0, 4)) : (fallbackYear ?? ordered[ordered.length - 1]!)
  return buildIso(String(preferred), String(month), String(day))
}