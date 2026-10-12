import { bankName, type BankId } from '../core/types'
import { abcParser } from './abc'
import { bocParser } from './boc'
import { bocomParser } from './bocom'
import { ccbParser } from './ccb'
import { citicParser } from './citic'
import { icbcParser } from './icbc'
import { ParseError, type BankParser, type SourceDocument, type SourceType } from './types'

/**
 * Explicit parser registry.
 *
 * Each bank owns a parser with a confidence-based `match`. There is deliberately no
 * "generic regex" fallback that could silently turn an unknown file into a
 * successful-looking import: an unrecognised file fails loudly.
 */
export const PARSERS: BankParser[] = [bocParser, bocomParser, icbcParser, ccbParser, abcParser, citicParser]

/**
 * UI-facing metadata for one registered parser.
 *
 * `BankParser` already carries the machine-readable identity (`id`, `bank`,
 * `sourceTypes`); this definition pairs it with the human-readable display
 * fields the Settings page needs so the UI never hardcodes a bank list.
 */
export interface ParserDefinition {
  id: string
  bank: BankId
  bankName: string
  sourceTypes: SourceType[]
  parser: BankParser
  /** Human-readable file kind, e.g. "文字型 PDF 账单". */
  fileTypeLabel: string
  /** Where the debit/credit direction comes from, e.g. "PDF 中的「存入 / 支出」列位置". */
  directionBasis: string
}

const PARSER_DISPLAY: Record<string, Pick<ParserDefinition, 'fileTypeLabel' | 'directionBasis'>> = {
  boc_pdf: {
    fileTypeLabel: '文字型 PDF 账单',
    directionBasis: 'PDF 中的「存入 / 支出」列位置',
  },
  bocom_eml: {
    fileTypeLabel: 'HTML 邮件账单 .eml',
    directionBasis: '账单分区（还款退货区 / 消费取现区）',
  },
  icbc_eml: {
    fileTypeLabel: 'HTML 邮件账单 .eml',
    directionBasis: '记账金额后缀（存入 / 支出）',
  },
  ccb_eml: {
    fileTypeLabel: 'HTML 邮件账单 .eml',
    directionBasis: '金额正负号（- 为还款 / 退款）',
  },
  abc_eml: {
    fileTypeLabel: 'HTML 邮件账单 .eml',
    directionBasis: '分区标记（● 还款 / 退货 / 消费 / 取现）与结算符号',
  },
  citic_eml: {
    fileTypeLabel: 'HTML 邮件账单 .eml',
    directionBasis: '金额正负号（- 为还款 / 退款）',
  },
}

/** Derived catalog: one entry per parser in `PARSERS`, in registration order. */
export const PARSER_DEFINITIONS: ParserDefinition[] = PARSERS.map((parser) => ({
  id: parser.id,
  bank: parser.bank,
  bankName: bankName(parser.bank),
  sourceTypes: [...parser.sourceTypes],
  parser,
  fileTypeLabel: PARSER_DISPLAY[parser.id]?.fileTypeLabel ?? parser.sourceTypes.join(', '),
  directionBasis: PARSER_DISPLAY[parser.id]?.directionBasis ?? '银行自有结构字段',
}))

/** Snapshot of the catalog so callers cannot mutate the registry. */
export function parserCatalog(): ParserDefinition[] {
  return [...PARSER_DEFINITIONS]
}

export function getParserDefinition(id: string): ParserDefinition | undefined {
  return PARSER_DEFINITIONS.find((entry) => entry.id === id)
}

/** Distinct source types across all parsers, e.g. ["pdf", "eml", "html"]. */
export function supportedSourceTypes(): SourceType[] {
  const seen = new Set<SourceType>()
  for (const parser of PARSERS) {
    for (const sourceType of parser.sourceTypes) seen.add(sourceType)
  }
  return [...seen]
}

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