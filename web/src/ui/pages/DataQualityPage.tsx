import { useEffect, useMemo, useState } from 'react'
import { useApp } from '../../app/AppStore'
import { REVIEW_FLAG_LABELS, bankName, type BankId } from '../../core/types'
import { BANK_PARSER_SOURCE_ID, buildDataQualityReport, type DataQualityReport } from '../../core/dataQuality'
import { listAttachmentHashes } from '../../db/repository'
import { Badge, EmptyState, Stat } from '../components/ui'

const HEALTH_META = {
  healthy: { label: '健康', tone: 'ok' },
  warning: { label: '需要注意', tone: 'warn' },
  critical: { label: '需要处理', tone: 'danger' },
} as const

export function DataQualityPage() {
  const { visibleTransactions, visibleStatements, visibleImports } = useApp()
  const [hashes, setHashes] = useState<Set<string> | null>(null)

  useEffect(() => {
    let cancelled = false
    void listAttachmentHashes()
      .then((next) => {
        if (!cancelled) setHashes(next)
      })
      .catch(() => {
        if (!cancelled) setHashes(new Set())
      })
    return () => {
      cancelled = true
    }
  }, [visibleImports.length])

  // One memoised pass over the ledger: no per-row React updates.
  const report = useMemo(
    () =>
      buildDataQualityReport({
        transactions: visibleTransactions,
        statements: visibleStatements,
        imports: visibleImports,
        attachmentHashes: hashes ?? new Set<string>(),
      }),
    [visibleTransactions, visibleStatements, visibleImports, hashes],
  )

  return (
    <>
      <div className="page-head">
        <div>
          <h1>数据质量</h1>
          <p>账本的数据完整性与可信程度一览。只统计、不修改任何交易与对账结果。</p>
        </div>
        <HealthBadge report={report} />
      </div>

      {hashes === null ? <div className="notice notice-info">正在统计原始文件…</div> : null}

      <DataQualityView report={report} />
    </>
  )
}

function HealthBadge({ report }: { report: DataQualityReport }) {
  const meta = HEALTH_META[report.health.level]
  return (
    <span data-testid="dq-health">
      <Badge tone={meta.tone}>
        {meta.label} · {report.health.score}
      </Badge>
    </span>
  )
}

export function DataQualityView({ report }: { report: DataQualityReport }) {
  const bankEntries = Object.entries(report.origins.byBank).sort((a, b) => b[1] - a[1])
  const flagEntries = Object.entries(report.flags.byFlag)
    .filter(([, count]) => count > 0)
    .sort((a, b) => b[1] - a[1])

  return (
    <>
      <div className="grid grid-stats">
        <Stat label="交易总数" value={<span data-testid="dq-total-transactions">{report.totals.transactions}</span>} hint={`账单 ${report.totals.statements} 份 · 导入 ${report.totals.imports} 次`} />
        <Stat
          label="银行账单"
          value={<span data-testid="dq-origin-bank">{report.origins.byOrigin.parser}</span>}
          hint="银行解析器导入的交易数"
        />
        <Stat
          label="历史迁移"
          value={<span data-testid="dq-origin-legacy">{report.origins.byOrigin.legacy_import}</span>}
          hint={sourceIdHint(report)}
        />
        <Stat
          label="原始文件已保存"
          value={<span data-testid="dq-archived">{report.evidence.archived}</span>}
          hint={`共 ${report.evidence.total} 个导入文件`}
        />
        <Stat
          label="原始文件缺失"
          value={<span data-testid="dq-missing">{report.evidence.missing}</span>}
          hint="历史导入或清理浏览器数据导致"
        />
        <Stat
          label="待处理问题交易"
          value={<span data-testid="dq-flagged">{report.review.flagged}</span>}
          hint={`未标记 ${report.review.unflagged} 笔`}
        />
      </div>

      {report.totals.transactions === 0 ? (
        <div className="card">
          <EmptyState title="还没有任何交易" hint="导入银行账单或历史数据后，这里会显示数据质量统计。" />
        </div>
      ) : null}

      <div className="grid grid-2">
        <div className="card">
          <div className="card-head">
            <div>
              <h2>数据来源</h2>
              <p>按 origin / sourceId / sourceType 统计，不改变任何来源标记</p>
            </div>
          </div>
          <div className="card-pad stack">
            <div className="row">
              <Badge tone="info">银行账单</Badge>
              <span data-testid="dq-source-bank">{report.origins.byOrigin.parser}</span>
            </div>
            <div className="row">
              <Badge tone="info">历史迁移</Badge>
              <span data-testid="dq-source-legacy">{report.origins.byOrigin.legacy_import}</span>
            </div>
            {Object.entries(report.origins.bySourceId).map(([sourceId, count]) => (
              <div className="row" key={sourceId}>
                <span className="mono subtle">{sourceId}</span>
                <span data-testid={`dq-source-${sourceId}`}>{count}</span>
              </div>
            ))}
            {Object.entries(report.importsBySourceType).map(([sourceType, count]) => (
              <div className="row" key={sourceType}>
                <span className="subtle">导入文件 · {sourceType}</span>
                <span data-testid={`dq-sourcetype-${sourceType}`}>{count}</span>
              </div>
            ))}
            {bankEntries.map(([bank, count]) => (
              <div className="row" key={bank}>
                <span className="subtle">{bankName(bank as BankId)}</span>
                <span>{count}</span>
              </div>
            ))}
          </div>
        </div>

        <div className="card">
          <div className="card-head">
            <div>
              <h2>原始文件完整性</h2>
              <p>有附件行即已归档，无附件行即缺失，不伪造文件</p>
            </div>
          </div>
          <div className="card-pad stack">
            <div className="row">
              <Badge tone="ok">已归档</Badge>
              <span data-testid="dq-archived-2">{report.evidence.archived}</span>
            </div>
            <div className="row">
              <Badge tone={report.evidence.missing > 0 ? 'warn' : 'muted'}>缺失</Badge>
              <span data-testid="dq-missing-2">{report.evidence.missing}</span>
            </div>
            {report.evidence.missing > 0 ? (
              <p className="subtle">
                缺失文件：
                {report.evidence.missingFiles.slice(0, 5).join('、')}
                {report.evidence.missingFiles.length > 5 ? ` 等 ${report.evidence.missingFiles.length} 个` : ''}
              </p>
            ) : null}
            <div className="row">
              <a className="btn btn-sm" href="#/import" data-testid="dq-goto-import">
                去导入 / 归档页处理
              </a>
              <a className="btn btn-sm" href="#/settings" data-testid="dq-goto-archive">
                去完整归档
              </a>
            </div>
          </div>
        </div>

        <div className="card">
          <div className="card-head">
            <div>
              <h2>交易与对账状态</h2>
              <p>复用已有 reviewStatus / statement status，不新增状态</p>
            </div>
          </div>
          <div className="card-pad stack">
            {(
              [
                ['ok', '正常'],
                ['pending', '待复核'],
                ['confirmed', '已确认'],
                ['rejected', '已排除'],
              ] as const
            ).map(([status, label]) => (
              <div className="row" key={status}>
                <span className="subtle">{label}</span>
                <span data-testid={`dq-review-${status}`}>{report.review.byReviewStatus[status]}</span>
              </div>
            ))}
            {(
              [
                ['reconciled', '对账通过'],
                ['needs_review', '待复核账单'],
                ['failed', '对账失败'],
                ['imported', '历史导入'],
              ] as const
            ).map(([status, label]) => (
              <div className="row" key={status}>
                <span className="subtle">{label}</span>
                <span data-testid={`dq-statement-${status}`}>{report.statements.byStatus[status]}</span>
              </div>
            ))}
            <div className="row">
              <a className="btn btn-sm" href="#/review" data-testid="dq-goto-review">
                去人工复核
              </a>
            </div>
          </div>
        </div>

        <div className="card">
          <div className="card-head">
            <div>
              <h2>待处理问题</h2>
              <p>点击数量跳转到已有复核页，不新建审核系统</p>
            </div>
            <Badge tone={report.review.flagged > 0 ? 'warn' : 'ok'}>{report.review.flagged}</Badge>
          </div>
          <div className="card-pad stack">
            {flagEntries.length === 0 ? <p className="subtle">没有标记问题，账本很干净。</p> : null}
            {flagEntries.map(([flag, count]) => (
              <div className="row" key={flag}>
                <a href="#/review" data-testid={`dq-flag-${flag}`} title="去人工复核">
                  {REVIEW_FLAG_LABELS[flag as keyof typeof REVIEW_FLAG_LABELS]}
                </a>
                <span data-testid={`dq-flag-${flag}-count`}>{count}</span>
              </div>
            ))}
            <div className="row">
              <span className="subtle">疑似重复交易</span>
              <span data-testid="dq-suspected">{report.duplicates.suspectedDuplicateTransactions}</span>
            </div>
            <div className="row">
              <span className="subtle">重复文件导入（已跳过）</span>
              <span data-testid="dq-duplicate-files">{report.duplicates.duplicateFileImports}</span>
            </div>
            <p className="subtle">导入去重基于已有 import 记录统计，未新增任何去重表。</p>
          </div>
        </div>
      </div>
    </>
  )
}

function sourceIdHint(report: DataQualityReport): string {
  const entries = Object.entries(report.origins.bySourceId).filter(([sourceId]) => sourceId !== BANK_PARSER_SOURCE_ID)
  if (entries.length === 0) return '暂无历史迁移来源'
  return entries.map(([sourceId, count]) => `${sourceId} ${count}`).join('；')
}
