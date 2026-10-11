/** Group PDF text items into visual rows, preserving x/y coordinates. */
import type { PdfPage, PdfTextItem } from './types'

export interface TextRow {
  y: number
  items: PdfTextItem[]
  text: string
}

export function groupRows(items: PdfTextItem[], tolerance = 3): TextRow[] {
  const sorted = [...items]
    .filter((item) => item.text.trim().length > 0)
    .sort((a, b) => b.y - a.y || a.x - b.x)

  const rows: Array<Omit<TextRow, 'text'>> = []
  for (const item of sorted) {
    const row = rows.find((candidate) => Math.abs(candidate.y - item.y) <= tolerance)
    if (row) {
      row.items.push(item)
    } else {
      rows.push({ y: item.y, items: [item] })
    }
  }
  const result: TextRow[] = rows.map((row) => ({ ...row, text: '' }))
  for (const row of result) {
    row.items.sort((a, b) => a.x - b.x)
    row.text = row.items
      .map((item) => item.text)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim()
  }
  return result.sort((a, b) => b.y - a.y)
}

export function pageRows(page: PdfPage, tolerance = 3): TextRow[] {
  return groupRows(page.items, tolerance)
}

export function itemCenterX(item: PdfTextItem): number {
  return item.x + item.width / 2
}

export function findRowMatching(rows: TextRow[], pattern: RegExp): TextRow | undefined {
  return rows.find((row) => pattern.test(row.text))
}

/**
 * Find the horizontal centre of the items whose text matches `pattern`,
 * ignoring rows already excluded. Returns `null` when nothing matched.
 */
export function findColumnAnchor(
  rows: TextRow[],
  pattern: RegExp,
  options: { excludePattern?: RegExp; minY?: number; maxY?: number } = {},
): number | null {
  const centers: number[] = []
  for (const row of rows) {
    if (options.minY !== undefined && row.y < options.minY) continue
    if (options.maxY !== undefined && row.y > options.maxY) continue
    for (const item of row.items) {
      if (!pattern.test(item.text)) continue
      if (options.excludePattern && options.excludePattern.test(item.text)) continue
      centers.push(itemCenterX(item))
    }
  }
  if (centers.length === 0) return null
  return centers.reduce((sum, value) => sum + value, 0) / centers.length
}

export function nearestAnchor(anchors: Array<{ key: string; center: number }>, x: number): { key: string; center: number } | null {
  let best: { key: string; center: number } | null = null
  let bestDistance = Number.POSITIVE_INFINITY
  for (const anchor of anchors) {
    const distance = Math.abs(anchor.center - x)
    if (distance < bestDistance) {
      bestDistance = distance
      best = anchor
    }
  }
  return best
}