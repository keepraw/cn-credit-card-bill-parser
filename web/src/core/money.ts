/**
 * Integer minor-unit money handling.
 *
 * Financial amounts are NEVER accumulated as JavaScript floats in this project.
 * Every amount is stored as an integer number of minor units (fen / cent / sen).
 * Parsing goes string -> integer digits, so no rounding error is introduced at
 * any point of the pipeline.
 */

export type CurrencyCode = string

/** Decimal places used by a currency. */
const CURRENCY_EXPONENT: Record<string, number> = {
  CNY: 2,
  RMB: 2,
  USD: 2,
  HKD: 2,
  EUR: 2,
  GBP: 2,
  SGD: 2,
  AUD: 2,
  CAD: 2,
  CHF: 2,
  JPY: 0,
  KRW: 0,
  VND: 0,
}

export function currencyExponent(currency: string): number {
  return CURRENCY_EXPONENT[(currency || 'CNY').toUpperCase()] ?? 2
}

/** Historical adapters must not guess the exponent of an unfamiliar currency. */
export function isSupportedCurrency(currency: string): boolean {
  return Object.hasOwn(CURRENCY_EXPONENT, currency.toUpperCase())
}

/** Convert minor units back to a plain decimal string (no float math involved). */
export function minorToDecimalString(minor: number, currency = 'CNY'): string {
  const exp = currencyExponent(currency)
  const negative = minor < 0
  const digits = Math.abs(Math.trunc(minor)).toString()
  let out: string
  if (exp === 0) {
    out = digits
  } else {
    const padded = digits.padStart(exp + 1, '0')
    out = `${padded.slice(0, padded.length - exp)}.${padded.slice(padded.length - exp)}`
  }
  return negative ? `-${out}` : out
}

/** Human readable amount, e.g. `-1,410.00`. */
export function formatMinor(minor: number, currency = 'CNY', options: { sign?: boolean } = {}): string {
  const exp = currencyExponent(currency)
  const negative = minor < 0
  const digits = Math.abs(Math.trunc(minor)).toString()
  let intPart: string
  let fracPart = ''
  if (exp === 0) {
    intPart = digits
  } else {
    const padded = digits.padStart(exp + 1, '0')
    intPart = padded.slice(0, padded.length - exp)
    fracPart = padded.slice(padded.length - exp)
  }
  const grouped = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  const body = fracPart ? `${grouped}.${fracPart}` : grouped
  const sign = negative ? '-' : options.sign === true ? '+' : ''
  return `${sign}${body}`
}

export interface ParsedAmount {
  /** Signed integer minor units. */
  minor: number
  /** Explicit sign discovered in the source text (parentheses, leading/trailing -, /C). */
  negativeByFormat: boolean
  /** Currency token detected next to the number, when present. */
  currency?: string
}

const CURRENCY_WORDS: Array<[RegExp, string]> = [
  [/(?:人民币|￥|¥|RMB|CNY)/i, 'CNY'],
  [/(?:美元|USD)/i, 'USD'],
  [/(?:港币|港元|HKD)/i, 'HKD'],
  [/(?:欧元|EUR)/i, 'EUR'],
  [/(?:日元|JPY)/i, 'JPY'],
  [/(?:英镑|GBP)/i, 'GBP'],
]

/**
 * Parse a bank-provided amount string into signed minor units.
 *
 * Recognised formats: `1,234.56`, `1234.56`, `-1234.56`, `1234.56-`, `(1234.56)`,
 * `1234.56/C`, `1234.56CR`, `CNY 1234.56`, `&yen;6512.48`.
 * Returns `null` when the text does not contain a usable number.
 */
export function parseAmountToMinor(raw: string | number | null | undefined, fallbackCurrency = 'CNY'): ParsedAmount | null {
  if (raw === null || raw === undefined) return null
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw)) return null
    if (!isSupportedCurrency(fallbackCurrency)) throw new Error(`尚未定义币种 ${fallbackCurrency} 的货币精度，拒绝猜测金额`)
    const scaled = raw * 10 ** currencyExponent(fallbackCurrency)
    const asInt = Math.round(scaled)
    if (!Number.isSafeInteger(asInt)) return null
    if (Math.abs(scaled - asInt) > 1e-6) return null
    return { minor: asInt, negativeByFormat: raw < 0 }
  }

  let text = String(raw).trim()
  if (!text) return null

  let currency: string | undefined
  for (const [re, code] of CURRENCY_WORDS) {
    if (re.test(text)) {
      currency = code
      break
    }
  }
  const codedCurrency = /^([A-Z]{3})(?=\s|[-+(\d])/i.exec(text)?.[1]?.toUpperCase()
  if (!currency && codedCurrency) currency = codedCurrency
  const effectiveCurrency = currency ?? fallbackCurrency
  if (!isSupportedCurrency(effectiveCurrency)) throw new Error(`尚未定义币种 ${effectiveCurrency} 的货币精度，拒绝猜测金额`)
  const signedText = text.replace(/^(?:人民币|美元|港币|港元|欧元|日元|英镑|[A-Z]{3}|[￥¥])\s*/i, '').trim()

  const negativeByFormat =
    /^\(.*\)$/.test(signedText) ||
    /\/\s*C\b/i.test(text) ||
    /\d\s*CR\b/i.test(text) ||
    /^-/.test(signedText) ||
    /-$/.test(text) ||
    /^[−–—]/.test(signedText) // unicode minus / en dash / em dash

  text = text
    .replace(/\/\s*[CD]\b/gi, '')
    .replace(/\bDR\b/gi, '')
    .replace(/\s*CR\b/gi, '')
    .replace(/[^\d.,\-−–—]/g, '')
    .replace(/[−–—]/g, '-')

  if (text.startsWith('-')) {
    text = text.slice(1)
  } else if (text.endsWith('-')) {
    text = text.slice(0, -1)
  }
  text = text.replace(/-/g, '')

  // Normalise the thousands/decimal separators without losing precision.
  if (text.includes(',') && text.includes('.')) {
    text = text.lastIndexOf(',') > text.lastIndexOf('.') ? text.replace(/\./g, '').replace(',', '.') : text.replace(/,/g, '')
  } else if (text.includes(',')) {
    text = /,\d{3}$/.test(text) ? text.replace(/,/g, '') : text.replace(',', '.')
  } else if ((text.match(/\./g) ?? []).length > 1) {
    text = text.replace(/\./g, '')
  }

  const match = /^(\d+)(?:\.(\d*))?$/.exec(text)
  if (!match) return null
  const integerPart = match[1] ?? '0'
  let fractionPart = match[2] ?? ''

  const exp = currencyExponent(effectiveCurrency)
  // Banks may format integer currencies as 100.00. Only zero fractional
  // digits may be discarded; 100.50 JPY remains invalid.
  if (exp === 0 && /^0*$/.test(fractionPart)) fractionPart = ''
  if (fractionPart.length > exp) {
    // More precision than the currency supports: refuse instead of rounding silently.
    return null
  }
  const scaledFraction = fractionPart.padEnd(exp, '0')
  const minor = Number(`${integerPart}${scaledFraction}`)
  if (!Number.isSafeInteger(minor)) return null

  return {
    minor: negativeByFormat ? -minor : minor,
    negativeByFormat,
    ...(currency ? { currency } : {}),
  }
}

/** Minor units -> integer yuan-style amount for tests/debugging only. */
export function minorToNumber(minor: number): number {
  return minor / 100
}

export function sumMinor(values: number[]): number {
  let total = 0
  for (const value of values) {
    if (!Number.isSafeInteger(value)) {
      throw new Error(`Non-integer minor unit encountered: ${value}`)
    }
    total += value
  }
  if (!Number.isSafeInteger(total)) throw new Error('Amount overflow while summing')
  return total
}
