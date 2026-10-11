import { useMemo, useState } from 'react'
import { useApp } from '../../app/AppStore'
import { DEFAULT_FILTERS, applyFilters, groupBy, groupByBank, monthlyTrend, summarize, untrustedAmount, type Filters } from '../../core/analytics'
import { bankName, type BankId } from '../../core/types'
import { formatMinor } from '../../core/money'
import { monthEnd } from '../../core/dates'
import { BarChart, Badge, DemoBadge, EmptyState, HorizontalBars, Stat } from '../components/ui'

const BANKS: BankId[] = ['boc', 'bocom', 'icbc', 'ccb', 'abc', 'citic']

export function DashboardPage() {
  const { visibleTransactions, visibleStatements, state } = useApp()
  const [filters, setFilters] = useState<Filters>(DEFAULT_FILTERS)

  const trusted = useMemo(() => {
    const untrusted = new Set(visibleStatements.filter((s) => s.status !== 'reconciled').map((s) => s.id))
    const base = filters.includeUnreconciled ? visibleTransactions : visibleTransactions.filter((tx) => !untrusted.has(tx.statementId))
    return applyFilters(base, filters)
  }, [filters, visibleStatements, visibleTransactions])

  const summary = useMemo(() => summarize(trusted), [trusted])
  const trend = useMemo(() => monthlyTrend(trusted), [trusted])
  const byBank = useMemo(() => groupByBank(trusted), [trusted])
  const byCard = useMemo(() => groupBy(trusted, (tx) => `${bankName(tx.bank)} ·${tx.cardLast4}`), [trusted])
  const excluded = useMemo(
    () => untrustedAmount(applyFilters(visibleTransactions, filters), visibleStatements),
    [filters, visibleStatements, visibleTransactions],
  )

  const cards = useMemo(
    () => [...new Set(visibleTransactions.map((tx) => tx.cardLast4))].filter(Boolean).sort(),
    [visibleTransactions],
  )
  const months = useMemo(() => trend.map((entry) => entry.month), [trend])
  const selectedMonth =
    filters.from && filters.to && filters.from.slice(0, 7) === filters.to.slice(0, 7) ? filters.from.slice(0, 7) : ''

  const hasData = visibleTransactions.length > 0
  const pendingStatements = visibleStatements.filter((s) => s.status !== 'reconciled').length

  return (
    <>
      <div className="page-head">
        <div>
          <h1>消费总览</h1>
          <p>实际消费额与银行账单入账金额分开统计，未通过对账的账单默认不计入。</p>
        </div>
        <div className="row">
          {months.length > 0 ? (
            <select
              className="select"
              value={selectedMonth}
              onChange={(event) => {
                const value = event.target.value
                setFilters((prev) => ({
                  ...prev,
                  from: value ? `${value}-01` : null,
                  to: value ? monthEnd(Number(value.slice(0, 4)), Number(value.slice(5, 7))) : null,
                }))
              }}
            >
              <option value="">全部月份</option>
              {months.map((month) => (
                <option key={month} value={month}>
                  {month}
                </option>
              ))}
            </select>
          ) : null}
          <select
            className="select"
            value={filters.banks[0] ?? ''}
            onChange={(event) => setFilters((prev) => ({ ...prev, banks: event.target.value ? [event.target.value as BankId] : [] }))}
          >
            <option value="">全部银行</option>
            {BANKS.map((bank) => (
              <option key={bank} value={bank}>
                {bankName(bank)}
              </option>
            ))}
          </select>
          <select
            className="select"
            value={filters.cards[0] ?? ''}
            onChange={(event) => setFilters((prev) => ({ ...prev, cards: event.target.value ? [event.target.value] : [] }))}
          >
            <option value="">全部卡片</option>
            {cards.map((card) => (
              <option key={card} value={card}>
                尾号 {card}
              </option>
            ))}
          </select>
          <label className="row row-tight subtle" style={{ cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={filters.includeUnreconciled}
              onChange={(event) => setFilters((prev) => ({ ...prev, includeUnreconciled: event.target.checked }))}
            />
            包含待复核账单
          </label>
        </div>
      </div>

      {state.demoMode ? (
        <div className="notice notice-warn">
          <Badge tone="demo">演示模式</Badge>
          <div>
            <strong>当前展示的全部为虚构示例数据</strong>
            <p>真实账单已被隐藏，演示数据不会被混入真实统计。关闭演示模式后可导入自己的 PDF / EML 账单。</p>
          </div>
        </div>
      ) : null}

      {!hasData ? (
        <div className="card">
          <EmptyState
            title="还没有任何账单数据"
            hint="到「账单导入」页拖入 PDF 或 EML 账单，或在「数据与设置」中开启演示模式。"
          />
        </div>
      ) : (
        <>
          <div className="grid grid-stats">
            <Stat
              label="实际消费额"
              value={`¥${formatMinor(summary.realSpendingMinor)}`}
              hint="消费 + 取现 + 分期每期入账，不含分期原始消费"
              badge={state.demoMode ? <DemoBadge /> : undefined}
            />
            <Stat label="退款额" value={`¥${formatMinor(summary.refundMinor)}`} hint="退货、退款等贷记交易" tone="neg" />
            <Stat label="返现额" value={`¥${formatMinor(summary.cashbackMinor)}`} hint="刷卡金、积分返还等" tone="neg" />
            <Stat
              label="账单入账净额"
              value={`¥${formatMinor(summary.netMinor)}`}
              hint={`借记 ${formatMinor(summary.billingDebitMinor)} / 贷记 ${formatMinor(summary.billingCreditMinor)}`}
            />
            <Stat label="还款额" value={`¥${formatMinor(summary.paymentMinor)}`} hint="仅统计，未计入消费" tone="neg" />
            <Stat label="费用与利息" value={`¥${formatMinor(summary.feeMinor + summary.interestMinor)}`} hint="手续费 + 利息" />
          </div>

          {pendingStatements > 0 && !filters.includeUnreconciled ? (
            <div className="notice notice-warn">
              <Badge tone="warn">{pendingStatements}</Badge>
              <div>
                <strong>有 {pendingStatements} 份账单未通过对账，暂未计入以上统计</strong>
                <p>
                  这些账单涉及金额 ¥{formatMinor(excluded)}。请到「人工复核」页查看差额原因，确认后再勾选「包含待复核账单」纳入统计。
                </p>
              </div>
            </div>
          ) : null}

          <div className="grid grid-2">
            <div className="card">
              <div className="card-head">
                <div>
                  <h2>月度消费趋势</h2>
                  <p>按交易日归月，退款单独统计</p>
                </div>
                <div className="legend">
                  <span>
                    <span className="legend-swatch" style={{ background: 'var(--navy-800)' }} />
                    消费
                  </span>
                </div>
              </div>
              <div className="card-pad">
                <BarChart
                  data={trend.map((entry) => ({ label: entry.month.slice(5), value: entry.spending, caption: entry.refund > 0 ? `退 ${formatMinor(entry.refund)}` : undefined }))}
                  formatValue={(value) => formatMinor(value)}
                />
              </div>
            </div>

            <div className="card">
              <div className="card-head">
                <div>
                  <h2>银行消费分布</h2>
                  <p>按实际消费额统计</p>
                </div>
              </div>
              <div className="card-pad">
                <HorizontalBars data={byBank.map((entry) => ({ label: bankName(entry.label as BankId), value: entry.value }))} formatValue={(v) => `¥${formatMinor(v)}`} />
              </div>
            </div>

            <div className="card">
              <div className="card-head">
                <div>
                  <h2>卡片消费分布</h2>
                  <p>银行 · 卡尾号</p>
                </div>
              </div>
              <div className="card-pad">
                <HorizontalBars data={byCard} formatValue={(v) => `¥${formatMinor(v)}`} />
              </div>
            </div>

            <div className="card">
              <div className="card-head">
                <div>
                  <h2>对账状态</h2>
                  <p>只有通过对账的账单才进入统计</p>
                </div>
              </div>
              <div className="card-pad stack">
                <div className="row">
                  <Badge tone="ok">{visibleStatements.filter((s) => s.status === 'reconciled').length}</Badge>
                  <span className="muted">份账单对账通过</span>
                </div>
                <div className="row">
                  <Badge tone={pendingStatements > 0 ? 'warn' : 'muted'}>{pendingStatements}</Badge>
                  <span className="muted">份账单待复核</span>
                </div>
                <div className="row">
                  <Badge tone="info">{summary.transactionCount}</Badge>
                  <span className="muted">笔交易纳入统计</span>
                </div>
              </div>
            </div>
          </div>
        </>
      )}
    </>
  )
}