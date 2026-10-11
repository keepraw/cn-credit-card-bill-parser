import { useCallback, useRef, useState } from 'react'
import { useApp } from '../../app/AppStore'
import { bankName, type ImportStatus } from '../../core/types'
import { Badge, DemoBadge, EmptyState } from '../components/ui'

const STATUS_META: Record<ImportStatus, { label: string; tone: 'ok' | 'warn' | 'danger' | 'info' | 'muted' }> = {
  parsed: { label: '解析成功', tone: 'ok' },
  needs_review: { label: '待复核', tone: 'warn' },
  duplicate: { label: '重复文件', tone: 'muted' },
  failed: { label: '解析失败', tone: 'danger' },
  unsupported: { label: '无法识别', tone: 'danger' },
}

export function ImportPage() {
  const { importFiles, state, visibleImports } = useApp()
  const [dragging, setDragging] = useState(false)
  const [results, setResults] = useState<ReturnType<typeof importFiles> extends Promise<infer T> ? T : never>([])
  const [error, setError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const handleFiles = useCallback(
    async (files: File[]) => {
      setError(null)
      try {
        const records = await importFiles(files)
        setResults(records)
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : '导入失败')
        setResults([])
      }
    },
    [importFiles],
  )

  const blocked = state.demoMode

  return (
    <>
      <div className="page-head">
        <div>
          <h1>账单导入</h1>
          <p>文件全程在浏览器内解析，不会被上传到任何服务器。</p>
        </div>
        <Badge tone="info">本地处理</Badge>
      </div>

      {blocked ? (
        <div className="notice notice-warn">
          <Badge tone="demo">演示模式</Badge>
          <div>
            <strong>演示模式下无法导入真实账单</strong>
            <p>请先在「数据与设置」中关闭演示模式，避免演示数据与真实账单混在一起。</p>
          </div>
        </div>
      ) : null}

      <div className="card">
        <div className="card-pad">
          <input
            ref={inputRef}
            type="file"
            accept=".pdf,.eml"
            multiple
            hidden
            data-testid="file-input"
            onChange={(event) => {
              const files = Array.from(event.target.files ?? [])
              event.target.value = ''
              if (files.length) void handleFiles(files)
            }}
          />
          <button
            type="button"
            className={`dropzone ${dragging ? 'is-active' : ''}`}
            disabled={blocked}
            data-testid="dropzone"
            onClick={() => inputRef.current?.click()}
            onDragOver={(event) => {
              event.preventDefault()
              setDragging(true)
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(event) => {
              event.preventDefault()
              setDragging(false)
              const files = Array.from(event.dataTransfer.files ?? [])
              if (files.length) void handleFiles(files)
            }}
          >
            <h2>{dragging ? '松开即可解析' : '拖拽 PDF / EML 账单到这里'}</h2>
            <p>也可以点击选择文件，支持一次导入多个文件。第一版支持中国银行文字型 PDF 与交通银行 HTML 邮件账单。</p>
          </button>

          {state.progress ? (
            <div className="stack" style={{ marginTop: 16 }}>
              <div className="row">
                <span className="muted">
                  {state.progress.fileName} · {state.progress.phase}（{state.progress.index + 1}/{state.progress.total}）
                </span>
              </div>
              <div className="progress-line">
                <span style={{ width: `${((state.progress.index + 1) / state.progress.total) * 100}%` }} />
              </div>
            </div>
          ) : null}

          {error ? (
            <div className="notice notice-danger" style={{ marginTop: 16 }}>
              <Badge tone="danger">导入失败</Badge>
              <div>{error}</div>
            </div>
          ) : null}
        </div>
      </div>

      {results.length > 0 ? (
        <div className="card">
          <div className="card-head">
            <div>
              <h2>本次导入结果</h2>
              <p>不识别的银行或文件会明确标记为失败，不会伪装成成功。</p>
            </div>
          </div>
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>文件</th>
                  <th>状态</th>
                  <th>银行</th>
                  <th>卡尾号</th>
                  <th>账单周期</th>
                  <th className="num">交易数</th>
                  <th>说明</th>
                </tr>
              </thead>
              <tbody>
                {results.map((record) => {
                  const meta = STATUS_META[record.status]
                  return (
                    <tr key={record.id} data-testid="import-row">
                      <td className="truncate" title={record.fileName}>
                        {record.fileName}
                      </td>
                      <td>
                        <Badge tone={meta.tone}>{meta.label}</Badge>
                      </td>
                      <td>{record.bank === 'unknown' ? '—' : bankName(record.bank)}</td>
                      <td>{record.cardLast4 || '—'}</td>
                      <td className="nowrap">{record.cycleStart && record.cycleEnd ? `${record.cycleStart} ~ ${record.cycleEnd}` : '—'}</td>
                      <td className="num">{record.transactionCount}</td>
                      <td className="muted">{record.message}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}

      <div className="card">
        <div className="card-head">
          <div>
            <h2>导入历史</h2>
            <p>文件 SHA-256 指纹用于识别重复导入</p>
          </div>
          {state.demoMode ? <DemoBadge /> : null}
        </div>
        {visibleImports.length === 0 ? (
          <EmptyState title="还没有导入记录" hint="导入的文件会显示在这里，包含指纹、银行与账单周期。" />
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>文件</th>
                  <th>状态</th>
                  <th>银行 / 卡</th>
                  <th>账单周期</th>
                  <th className="num">交易数</th>
                  <th>SHA-256</th>
                  <th>时间</th>
                </tr>
              </thead>
              <tbody>
                {visibleImports
                  .slice()
                  .sort((a, b) => b.importedAt.localeCompare(a.importedAt))
                  .map((record) => {
                    const meta = STATUS_META[record.status]
                    return (
                      <tr key={record.id}>
                        <td className="truncate" title={record.fileName}>
                          {record.fileName}
                          {record.isDemo ? <Badge tone="demo">演示</Badge> : null}
                        </td>
                        <td>
                          <Badge tone={meta.tone}>{meta.label}</Badge>
                        </td>
                        <td>
                          {record.bank === 'unknown' ? '—' : bankName(record.bank)} {record.cardLast4 || ''}
                        </td>
                        <td className="nowrap">{record.cycleStart && record.cycleEnd ? `${record.cycleStart} ~ ${record.cycleEnd}` : '—'}</td>
                        <td className="num">{record.transactionCount}</td>
                        <td className="mono subtle">{record.fileHash.slice(0, 16)}…</td>
                        <td className="nowrap subtle">{new Date(record.importedAt).toLocaleString('zh-CN')}</td>
                      </tr>
                    )
                  })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {visibleImports.some((r) => r.status === 'needs_review') ? (
        <div className="notice notice-warn">
          <Badge tone="warn">待处理</Badge>
          <div>
            <strong>有账单需要人工复核</strong>
            <p>这些账单已解析，但未通过对账校验，因此没有计入统计。请到「人工复核」页查看差额与原始片段。</p>
          </div>
        </div>
      ) : null}
    </>
  )
}