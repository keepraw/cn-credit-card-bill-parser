import type { HtmlTable } from './types'

/**
 * Hardened HTML handling for statement e-mails.
 *
 * The raw HTML is never rendered and never assigned to `innerHTML`; it is only
 * turned into text and table cells here. Remote images, tracking pixels, scripts,
 * iframes and form controls are removed up front so nothing can be requested.
 */

const DANGEROUS_TAGS = ['script', 'style', 'img', 'iframe', 'object', 'embed', 'form', 'link', 'meta', 'base', 'video', 'audio', 'source', 'input', 'button']

export function sanitizeHtml(html: string): string {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  for (const tag of DANGEROUS_TAGS) {
    for (const node of Array.from(doc.querySelectorAll(tag))) node.remove()
  }
  for (const node of Array.from(doc.querySelectorAll('*'))) {
    for (const attr of Array.from(node.attributes)) {
      const name = attr.name.toLowerCase()
      if (name.startsWith('on') || name === 'src' || name === 'srcset' || name === 'background' || name === 'href' || name === 'xlink:href') {
        node.removeAttribute(attr.name)
      }
    }
  }
  return doc.documentElement.innerHTML
}

/**
 * Flatten tables into `rows` arrays of trimmed cell text.
 *
 * Statement e-mails wrap their content in nested layout tables, so a plain
 * `table.querySelectorAll('tr')` would return every transaction row once per
 * wrapper. Rows are therefore walked in document order and attributed to their
 * *innermost* table, and wrapper rows that only exist to hold another table are
 * dropped. The result is a clean, de-duplicated, document-ordered row stream.
 */
export function extractTables(html: string): HtmlTable[] {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  const tables: HtmlTable[] = []
  let currentOwner: Element | null = null

  for (const tr of Array.from(doc.querySelectorAll('tr'))) {
    // A row that contains other rows is a layout wrapper, not a data row.
    if (tr.querySelector('tr')) continue
    const owner = tr.closest('table')
    if (!owner) continue

    if (owner !== currentOwner) {
      currentOwner = owner
      tables.push({ index: tables.length, rows: [] })
    }
    const bucket = tables[tables.length - 1]!
    const cells = Array.from(tr.children)
      .filter((cell) => cell.tagName === 'TD' || cell.tagName === 'TH')
      .map((cell) => normalizeCell(cell.textContent ?? ''))
    if (cells.some((cell) => cell.length > 0)) bucket.rows.push(cells)
  }

  return tables.filter((table) => table.rows.length > 0)
}

export function normalizeCell(text: string): string {
  return text
    .replace(/[\u00a0\u3000]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Plain text of the document, used for bank detection only. */
export function extractText(html: string): string {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  for (const tag of ['script', 'style', 'head']) {
    for (const node of Array.from(doc.querySelectorAll(tag))) node.remove()
  }
  return (doc.body?.textContent ?? '').replace(/[\u00a0\u3000]/g, ' ').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim()
}

const ENTITIES: Record<string, string> = {
  '&yen;': '¥',
  '&yen': '¥',
  '&nbsp;': ' ',
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&apos;': "'",
  '&ldquo;': '“',
  '&rdquo;': '”',
  '&middot;': '·',
}

export function decodeEntities(text: string): string {
  return text
    .replace(/&[a-zA-Z#0-9]+;/g, (entity) => {
      const mapped = ENTITIES[entity] ?? ENTITIES[entity.toLowerCase()]
      if (mapped !== undefined) return mapped
      const numeric = /^&#(\d+);$/.exec(entity)
      if (numeric) return String.fromCodePoint(Number(numeric[1]))
      return entity
    })
    .replace(/&(?!amp;|lt;|gt;|quot;|#\d+;)/g, '&amp;')
}