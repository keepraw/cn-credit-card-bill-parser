import { useEffect, useRef, useState } from 'react'
import { useApp } from '../../app/AppStore'
import { storageEstimate } from '../../db/repository'
import { parserCatalog } from '../../parsers/registry'
import { Badge, DemoBadge } from '../components/ui'

export function SettingsPage() {
  const { state, setSettings, backup, restore, clearData, loadDemoData } = useApp()
  const [message, setMessage] = useState<{ tone: 'ok' | 'danger'; text: string } | null>(null)
  const [usage, setUsage] = useState<{ usage: number; quota: number } | null>(null)
  const restoreRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    void storageEstimate().then(setUsage)
  }, [state.statements.length, state.transactions.length])

  const realCounts = {
    statements: state.statements.filter((s) => !s.isDemo).length,
    transactions: state.transactions.filter((t) => !t.isDemo).length,
  }
  const demoCounts = {
    statements: state.statements.filter((s) => s.isDemo).length,
    transactions: state.transactions.filter((t) => t.isDemo).length,
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h1>数据与设置</h1>
          <p>所有数据保存在本机浏览器的 IndexedDB 中，没有任何后端服务。</p>
        </div>
      </div>

      <div className="notice notice-info">
        <Badge tone="info">隐私</Badge>
        <div>
          <strong>账单不会离开这台设备</strong>
          <p>
            本项目没有后端、没有云端 AI 解析、没有统计埋点。导入的 PDF / EML 只在浏览器进程内解析。
            请注意：清理浏览器数据、使用无痕窗口或更换设备都会导致 IndexedDB 中的数据丢失，建议定期导出备份。
          </p>
        </div>
      </div>

      <div className="grid grid-2">
        <div className="card">
          <div className="card-head">
            <div>
              <h2>外观</h2>
              <p>浅色 / 深色 / 跟随系统</p>
            </div>
          </div>
          <div className="card-pad stack">
            <div className="segmented" role="group" aria-label="主题">
              {(['light', 'dark', 'system'] as const).map((theme) => (
                <button
                  key={theme}
                  type="button"
                  data-testid={`theme-${theme}`}
                  aria-pressed={state.settings.theme === theme}
                  onClick={() => void setSettings({ theme })}
                >
                  {theme === 'light' ? '浅色' : theme === 'dark' ? '深色' : '跟随系统'}
                </button>
              ))}
            </div>
            <p className="subtle">语言当前为简体中文，文案结构预留了后续扩展其它语言的空间。</p>
          </div>
        </div>

        <div className="card">
          <div className="card-head">
            <div>
              <h2>演示模式</h2>
              <p>使用完全虚构的数据体验全部页面</p>
            </div>
            {state.demoMode ? <DemoBadge /> : null}
          </div>
          <div className="card-pad stack">
            <label className="row" style={{ cursor: 'pointer' }}>
              <input
                type="checkbox"
                data-testid="demo-toggle"
                checked={state.demoMode}
                onChange={(event) => void setSettings({ demoMode: event.target.checked })}
              />
              <span>开启演示模式（隐藏真实数据，禁止导入）</span>
            </label>
            <p className="subtle">
              演示数据共 {demoCounts.statements} 份账单、{demoCounts.transactions} 笔交易，全部为虚构内容，卡尾号为 0000 / 9999。
              真实数据 {realCounts.statements} 份账单、{realCounts.transactions} 笔交易，演示模式开启时不会显示。
            </p>
            <button className="btn" type="button" onClick={() => void loadDemoData()}>
              重新生成演示数据
            </button>
          </div>
        </div>

        <div className="card">
          <div className="card-head">
            <div>
              <h2>本地备份</h2>
              <p>导出 / 恢复全部数据</p>
            </div>
          </div>
          <div className="card-pad stack">
            <p className="subtle">
              备份文件包含账单汇总、交易明细和复核状态，请自行妥善保管。恢复采用按主键合并的方式，重复恢复不会产生重复数据。
            </p>
            <div className="row">
              <button className="btn btn-primary" type="button" data-testid="backup" onClick={() => void backup()}>
                导出备份 (JSON)
              </button>
              <button className="btn" type="button" onClick={() => restoreRef.current?.click()}>
                从备份恢复
              </button>
              <input
                ref={restoreRef}
                type="file"
                accept="application/json,.json"
                hidden
                onChange={async (event) => {
                  const file = event.target.files?.[0]
                  event.target.value = ''
                  if (!file) return
                  const result = await restore(file)
                  setMessage({ tone: result.ok ? 'ok' : 'danger', text: result.message })
                }}
              />
            </div>
            {usage ? (
              <p className="subtle">
                本地存储占用约 {(usage.usage / 1024 / 1024).toFixed(2)} MB / 配额 {(usage.quota / 1024 / 1024).toFixed(0)} MB
              </p>
            ) : null}
          </div>
        </div>

        <div className="card">
          <div className="card-head">
            <div>
              <h2>清空数据</h2>
              <p>此操作不可撤销，请先导出备份</p>
            </div>
          </div>
          <div className="card-pad stack">
            <button
              className="btn btn-danger"
              type="button"
              data-testid="clear-real"
              onClick={() => {
                if (!window.confirm('确定要清空全部真实账单与交易数据吗？此操作不可撤销。')) return
                void clearData(false).then(() => setMessage({ tone: 'ok', text: '真实数据已清空。' }))
              }}
            >
              清空真实数据
            </button>
            <button
              className="btn btn-danger"
              type="button"
              onClick={() => {
                if (!window.confirm('确定要清空全部数据（含演示数据）吗？此操作不可撤销。')) return
                void clearData(true).then(() => setMessage({ tone: 'ok', text: '全部数据已清空。' }))
              }}
            >
              清空全部数据
            </button>
            {message ? (
              <div className={`notice ${message.tone === 'ok' ? 'notice-info' : 'notice-danger'}`}>
                <Badge tone={message.tone === 'ok' ? 'ok' : 'danger'}>{message.tone === 'ok' ? '完成' : '失败'}</Badge>
                <div>{message.text}</div>
              </div>
            ) : null}
          </div>
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <div>
            <h2>支持的账单格式</h2>
            <p>第一阶段范围（来自 parser registry，共 {parserCatalog().length} 个解析器）</p>
          </div>
        </div>
        <div className="table-wrap">
          <table className="data" data-testid="supported-parsers">
            <thead>
              <tr>
                <th>银行</th>
                <th>文件类型</th>
                <th>解析器</th>
                <th>方向依据</th>
              </tr>
            </thead>
            <tbody>
              {parserCatalog().map((entry) => (
                <tr key={entry.id} data-testid={`parser-row-${entry.id}`}>
                  <td>{entry.bankName}</td>
                  <td>
                    {entry.fileTypeLabel} <span className="mono">({entry.sourceTypes.join(', ')})</span>
                  </td>
                  <td className="mono">{entry.id}</td>
                  <td>{entry.directionBasis}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="card-pad">
          <p className="subtle">
            其他银行暂时不会被猜测识别：无法匹配时会明确标记为「无法识别」，而不是尝试用通用正则硬解析。
          </p>
        </div>
      </div>
    </>
  )
}