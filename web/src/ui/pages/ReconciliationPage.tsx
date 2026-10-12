import { useMemo } from 'react'
import { useApp } from '../../app/AppStore'
import { formatMinor } from '../../core/money'
import { describeReconciliationStatus, reconcileManyStatements } from '../../core/reconciliation'
import { bankName } from '../../core/types'
import { Badge, EmptyState, Stat } from '../components/ui'

/**
 * Statement-level reconciliation overview (read-only).
 *
 * Shows, per statement: bank + cycle, transaction count, system-computed
 * total, bank total (when the parser provided one), difference and status
 * (通过 / 不匹配 / 信息不足). Never auto-fixes, never guesses missing data.
 * Grouping + reconciliation run once inside `useMemo` so opening the page
 * does not recompute per row.
 */
export function ReconciliationPage() {
  const { visibleStatements, visibleTransactions } = useApp()

  const results = useMemo(
    () => reconcileManyStatements(visibleStatements, visibleTransactions),
    [visibleStatements, visibleTransactions],
  )

  const counts = useMemo(() => {
    let passed = 0
    let mismatch = 0
    let insufficient = 0
    for (const result of results.values()) {
      if (result.status === 'passed') passed += 1
      else if (result.status === 'mismatch') mismatch += 1
      else insufficient += 1
    }
    return { passed, mismatch, insufficient }
  }, [results])

  const rows = useMemo(
    () =>
      [...visibleStatements].sort((a, b) => (b.cycleEnd ?? '').localeCompare(a.cycleEnd ?? '')),
    [visibleStatements],
  )

  return (
    <>
      <div className="page-head">
        <div>
          <h1>账单核验</h1>
          <p>判断每个账单的交易是否完整、一致。不修复交易、不调整金额、不猜测缺失数据。</p>
        </div>
      </div>

      <div className="grid grid-stats">
        <Stat
          label="核验通过"
          value={<span data-testid="recon-passed">{counts.passed}</span>}
          hint="交易合计与银行金额一致"
        />
        <Stat
          label="不匹配"
          value={<span data-testid="recon-mismatch">{counts.mismatch}</span>}
          hint="有足够信息但金额不一致"
        />
        <Stat
          label="信息不足"
          value={<span data-testid="recon-insufficient">{counts.insufficient}</span>}
          hint="缺少可靠的银行金额字段"
        />
      </div>

      {rows.length === 0 ? (
        <div className="card">
          <EmptyState title="还没有任何账单" hint="导入银行账单后，这里会显示每个账单的核验结果。" />
        </div>
      ) : (
        <div className="card" data-testid="recon-page">
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>账单</th>
                  <th className="num">交易数量</th>
                  <th className="num">系统计算合计</th>
                  <th className="num">银行金额</th>
                  <th className="num">差额</th>
                  <th>状态</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((statement) => {
                  const result = results.get(statement.id)
                  if (!result) return null
                  return (
                    <tr key={statement.id} data-testid="recon-row">
                      <td>
                        {bankName(statement.bank)} 尾号{statement.cardLast4}
                        <div className="subtle">
                          {statement.cycleStart && statement.cycleEnd
                            ? `${statement.cycleStart} ~ ${statement.cycleEnd}`
                            : '账单周期未知'}
                        </div>
                        <div className="subtle truncate">{statement.sourceFileName}</div>
                      </td>
                      <td className="num" data-testid="recon-count">
                        {result.transactionCount}
                      </td>
                      <td className="num" data-testid="recon-total">
                        {formatMinor(result.transactionTotalMinor, result.currency)}
                      </td>
                      <td className="num" data-testid="recon-expected">
                        {result.expectedTotalMinor === null ? '—' : formatMinor(result.expectedTotalMinor, result.currency)}
                      </td>
                      <td className="num" data-testid="recon-difference">
                        {result.differenceMinor === null ? '—' : formatMinor(result.differenceMinor, result.currency)}
                      </td>
                      <td>
                        <span data-testid={`recon-status-${result.status}`}>
                          <ReconBadge status={result.status} />
                        </span>
                        <div className="subtle">{result.reason}</div>
                        {result.status === 'mismatch' ? (
                          <div>
                            <a className="btn btn-sm" href="#/review" data-testid="recon-goto-review">
                              去复核
                            </a>
                          </div>
                        ) : null}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
          <div className="card-pad">
            <p className="subtle">
              核验规则（第一阶段）：统计该账单下交易金额总和，与银行可靠金额字段比较；缺失银行金额时标记为信息不足，不伪造。复用已有
              Statement.reconciliation.status，不新增字段。{describeReconciliationStatus('passed')} /
              {describeReconciliationStatus('mismatch')} /{describeReconciliationStatus('insufficient')}。
            </p>
          </div>
        </div>
      )}
    </>
  )
}

function ReconBadge({ status }: { status: 'passed' | 'mismatch' | 'insufficient' }) {
  if (status === 'passed') return <Badge tone="ok">通过</Badge>
  if (status === 'mismatch') return <Badge tone="danger">不匹配</Badge>
  return <Badge tone="warn">信息不足</Badge>
}
