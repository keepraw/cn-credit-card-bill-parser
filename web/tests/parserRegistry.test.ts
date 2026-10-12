import { describe, expect, it } from 'vitest'
import { bankName } from '../src/core/types'
import {
  getParserDefinition,
  PARSER_DEFINITIONS,
  PARSERS,
  parserCatalog,
  supportedBanks,
  supportedSourceTypes,
} from '../src/parsers/registry'

describe('parser registry', () => {
  it('registers the current 5 parsers', () => {
    expect(PARSERS).toHaveLength(5)
    expect(PARSER_DEFINITIONS).toHaveLength(5)
    expect(new Set(PARSERS.map((parser) => parser.id))).toEqual(
      new Set(['boc_pdf', 'bocom_eml', 'icbc_eml', 'ccb_eml', 'abc_eml']),
    )
  })

  it('keeps every parser id unique', () => {
    const ids = PARSERS.map((parser) => parser.id)
    expect(new Set(ids).size).toBe(ids.length)
    const definitionIds = PARSER_DEFINITIONS.map((entry) => entry.id)
    expect(new Set(definitionIds).size).toBe(definitionIds.length)
  })

  it('gives every parser a bankName and non-empty sourceTypes', () => {
    for (const parser of PARSERS) {
      expect(parser.bank).toBeTruthy()
      expect(bankName(parser.bank)).toBeTruthy()
      expect(bankName(parser.bank)).not.toBe('')
      expect(parser.sourceTypes.length).toBeGreaterThan(0)
    }
    for (const entry of PARSER_DEFINITIONS) {
      expect(entry.bankName).toBeTruthy()
      expect(entry.bankName).toBe(bankName(entry.bank))
      expect(entry.sourceTypes.length).toBeGreaterThan(0)
      expect(entry.parser).toBeDefined()
      expect(entry.parser.id).toBe(entry.id)
    }
  })

  it('exposes one definition per parser with matching metadata', () => {
    for (const parser of PARSERS) {
      const definition = getParserDefinition(parser.id)
      expect(definition).toBeDefined()
      expect(definition!.bank).toBe(parser.bank)
      expect(definition!.bankName).toBe(bankName(parser.bank))
      expect(definition!.sourceTypes).toEqual(parser.sourceTypes)
      expect(definition!.parser).toBe(parser)
      expect(definition!.fileTypeLabel).toBeTruthy()
      expect(definition!.directionBasis).toBeTruthy()
    }
  })

  it('covers all 5 banks and advertises pdf + eml source types', () => {
    expect(supportedBanks().sort()).toEqual(['abc', 'boc', 'bocom', 'ccb', 'icbc'])
    const sourceTypes = supportedSourceTypes()
    expect(sourceTypes).toContain('pdf')
    expect(sourceTypes).toContain('eml')
    // parserCatalog returns a copy so callers cannot mutate the registry.
    const catalog = parserCatalog()
    expect(catalog).toHaveLength(5)
    expect(catalog).not.toBe(PARSER_DEFINITIONS)
  })
})
