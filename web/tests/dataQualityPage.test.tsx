import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { buildDataQualityReport } from '../src/core/dataQuality'
import { DataQualityView } from '../src/ui/pages/DataQualityPage'

vi.mock('../src/app/AppStore', () => ({
  useApp: () => ({ visibleTransactions: [], visibleStatements: [], visibleImports: [] }),
}))

vi.mock('../src/db/repository', () => ({
  listAttachmentHashes: vi.fn().mockResolvedValue(new Set()),
}))

describe('DataQuality page', () => {
  it('renders key metrics and action entries to existing pages', () => {
    const report = buildDataQualityReport({
      transactions: [],
      statements: [],
      imports: [],
      attachmentHashes: [],
    })
    // Simulate a ledger with known problem counts for the view.
    const viewReport = {
      ...report,
      totals: { transactions: 18286, statements: 12, imports: 565 },
      origins: {
        byOrigin: { parser: 0, legacy_import: 18286 },
        bySourceId: { 'legacy-python-export-v1': 18286 },
        byBank: { boc: 18286 },
      },
      evidence: { total: 565, archived: 523, missing: 42, missingFiles: ['old-bill.pdf'] },
      review: { total: 18286, byReviewStatus: { ok: 18274, pending: 12, confirmed: 0, rejected: 0 }, flagged: 12, unflagged: 18274 },
      flags: {
        flaggedTransactions: 12,
        byFlag: { ...report.flags.byFlag, low_confidence: 12 },
      },
      actions: { needsReviewTransactions: 12, needsReviewStatements: 2, missingAttachments: 42 },
    }

    render(<DataQualityView report={viewReport} />)

    expect(screen.getByTestId('dq-total-transactions')).toHaveTextContent('18286')
    expect(screen.getByTestId('dq-origin-legacy')).toHaveTextContent('18286')
    expect(screen.getByTestId('dq-archived')).toHaveTextContent('523')
    expect(screen.getByTestId('dq-missing')).toHaveTextContent('42')
    expect(screen.getByTestId('dq-flag-low_confidence-count')).toHaveTextContent('12')

    // Action entries reuse existing pages instead of inventing new flows.
    expect(screen.getByTestId('dq-goto-review').getAttribute('href')).toContain('review')
    expect(screen.getByTestId('dq-goto-import').getAttribute('href')).toContain('import')
    expect(screen.getByTestId('dq-goto-archive').getAttribute('href')).toContain('settings')
    // Flag links jump to the existing review queue.
    expect(screen.getByTestId('dq-flag-low_confidence').getAttribute('href')).toContain('review')
  })
})
