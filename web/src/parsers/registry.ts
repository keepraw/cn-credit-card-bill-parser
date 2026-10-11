import type { BankId } from '../core/types'
import { bocParser } from './boc'
import { bocomParser } from './bocom'
import { ParseError, type BankParser, type SourceDocument } from './types'

/**
 * Explicit parser registry.
 *
 * Each bank owns a parser with a confidence-based `match`. There is deliberately no
 * "generic regex" fallback that could silently turn an unknown file into a
 * successful-looking import: an unrecognised file fails loudly.
 */
export const PARSERS: BankParser[] = [bocParser, bocomParser]

export interface ParserMatch {
  parser: BankParser
  score: number
}

export function detectParser(doc: SourceDocument): ParserMatch | null {
  let best: ParserMatch | null = null
  for (const parser of PARSERS) {
    if (!parser.sourceTypes.includes(doc.sourceType)) continue
    let score = 0
    try {
      score = parser.match(doc)
    } catch {
      score = 0
    }
    if (score <= 0) continue
    if (!best || score > best.score) best = { parser, score }
  }
  return best
}

export function supportedBanks(): BankId[] {
  return PARSERS.map((parser) => parser.bank)
}

export class UnsupportedFileError extends Error {
  constructor(readonly fileName: string, readonly sourceType: string) {
    super(`无法识别 ${fileName} 的银行与账单格式`)
    this.name = 'UnsupportedFileError'
  }
}

export function parseDocument(doc: SourceDocument, parser: BankParser): ReturnType<BankParser['parse']> {
  try {
    return parser.parse(doc)
  } catch (error) {
    if (error instanceof ParseError) throw error
    throw new ParseError(
      `解析失败：${error instanceof Error ? error.message : '未知错误'}`,
      'parser_exception',
    )
  }
}