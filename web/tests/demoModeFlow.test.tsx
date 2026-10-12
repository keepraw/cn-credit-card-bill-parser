import { beforeEach, describe, expect, it } from 'vitest'
import { act, render, screen, waitFor } from '@testing-library/react'
import { AppProvider, useApp } from '../src/app/AppStore'
import { db } from '../src/db/db'
import { getArchiveStatus, persistImportResults } from '../src/db/repository'
import { buildDemoDataset } from '../src/demo/demoData'
import { clearDemoCache } from '../src/demo/demoStore'

const EMPTY_STATUS = { transactionCount: 0, importCount: 0, archivedCount: 0, missingCount: 0 }

async function clearDb(): Promise<void> {
  await db.transaction(
    'rw',
    [db.statements, db.transactions, db.imports, db.settings, db.attachments, db.reviewNotes],
    async () => {
      await db.statements.clear()
      await db.transactions.clear()
      await db.imports.clear()
      await db.settings.clear()
      await db.attachments.clear()
      await db.reviewNotes.clear()
    },
  )
}

function Probe() {
  const { state, visibleStatements, visibleTransactions, setSettings } = useApp()
  return (
    <div>
      <span data-testid="flow-ready">{state.ready ? 'yes' : 'no'}</span>
      <span data-testid="flow-demo">{state.demoMode ? 'on' : 'off'}</span>
      <span data-testid="flow-statements">{visibleStatements.length}</span>
      <span data-testid="flow-transactions">{visibleTransactions.length}</span>
      <button data-testid="flow-disable" type="button" onClick={() => void setSettings({ demoMode: false })}>
        off
      </button>
    </div>
  )
}

beforeEach(async () => {
  clearDemoCache()
  await clearDb()
})

describe('demo mode end-to-end isolation', () => {
  it('shows demo data without writing to Dexie; disabling reports empty real state', async () => {
    render(
      <AppProvider>
        <Probe />
      </AppProvider>,
    )
    // First visit lands in Demo Mode.
    await waitFor(() => expect(screen.getByTestId('flow-ready')).toHaveTextContent('yes'))
    expect(screen.getByTestId('flow-demo')).toHaveTextContent('on')
    expect(screen.getByTestId('flow-statements')).toHaveTextContent('8')
    expect(screen.getByTestId('flow-transactions')).toHaveTextContent('94')

    // Production tables untouched: demo lives in memory only.
    expect(await db.transactions.count()).toBe(0)
    expect(await db.statements.count()).toBe(0)
    expect(await db.imports.count()).toBe(0)

    // Disable demo: real (empty) state everywhere, including archive status.
    act(() => {
      screen.getByTestId('flow-disable').click()
    })
    await waitFor(() => expect(screen.getByTestId('flow-demo')).toHaveTextContent('off'))
    expect(screen.getByTestId('flow-statements')).toHaveTextContent('0')
    expect(screen.getByTestId('flow-transactions')).toHaveTextContent('0')
    expect(await getArchiveStatus()).toEqual(EMPTY_STATUS)
  })

  it('migrates a legacy database by purging demo rows without touching real data', async () => {
    // Legacy state: demo rows persisted by an older version plus one real row.
    await persistImportResults(buildDemoDataset())
    const [first] = buildDemoDataset()
    await db.transactions.put({ ...first!.transactions[0]!, id: 'real-tx-0', statementId: 'real-stmt', isDemo: false })
    expect(await db.transactions.count()).toBe(94 + 1)

    render(
      <AppProvider>
        <Probe />
      </AppProvider>,
    )
    await waitFor(() => expect(screen.getByTestId('flow-ready')).toHaveTextContent('yes'))

    // Only the real row survives the startup purge.
    expect(await db.transactions.count()).toBe(1)
    expect(await getArchiveStatus()).toEqual({
      transactionCount: 1,
      importCount: 0,
      archivedCount: 0,
      missingCount: 0,
    })
  })
})
