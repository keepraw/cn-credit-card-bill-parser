import * as XLSX from 'xlsx'
import { createHash } from 'node:crypto'

export const SEED = 0x4b524c31
export const FORMATS = {
  python: { sheet: '标准字段', columns: ['bank', 'card_last4', 'statement_start', 'statement_end', 'transaction_date', 'posting_date', 'description', 'transaction_currency', 'transaction_amount', 'settlement_currency', 'settlement_amount', 'source_file_name', 'source_file_hash', 'confidence', 'raw_text'] },
  keepraw: { sheet: '交易明细', columns: ['银行', '卡尾号', '交易日', '入账日', '说明', '交易币种', '交易金额', '结算币种', '结算金额'] },
  unified: { sheet: '统一账单', columns: ['银行名称', '卡号', '交易日期', '入账日期', '交易详情', '交易币种', '交易金额', '入账币种', '入账金额'] },
}
const banks = ['中国银行', '工商银行', '农业银行', '建设银行', '交通银行', '中信银行']
const merchants = [
  '微信支付 财付通 星河咖啡 上海南京西路店', '支付宝 云杉生活超市 北京朝阳店',
  '京东支付 北辰数码商城 线上订单', '美团支付 春雨餐饮 深圳科技园店',
  '银联云闪付 城市公交 地铁乘车', '滴滴出行 广州天河', '中石化加油 杭州滨江站',
  '携程旅行 山海酒店 成都春熙路店', '市民服务 水电燃气缴费', '明德书店 苏州工业园区',
  '星辰药房 武汉江汉路店', '腾讯视频 会员订阅', 'AMAZON MARKETPLACE SEATTLE US',
  'BLUE RIVER COFFEE LONDON GB', 'HARBOUR HOTEL KOWLOON HK', 'SAKURA BOOK SHOP TOKYO JP',
  'NORTH STAR RESTAURANT PARIS FR', 'METRO TRANSIT SINGAPORE SG', 'CLOUD MUSIC SUBSCRIPTION',
  '支付宝 青禾便利店 杭州西湖店', '微信支付 小满面馆 南京新街口店',
]
const currencies = ['CNY', 'USD', 'HKD', 'JPY', 'EUR']
function random(seed) {
  return () => {
    seed |= 0; seed = seed + 0x6d2b79f5 | 0
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed)
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t
    return ((t ^ t >>> 14) >>> 0) / 4294967296
  }
}
const iso = ms => new Date(ms).toISOString().slice(0, 10)
const minorString = (value, currency) => currency === 'JPY' ? String(value) : `${value < 0 ? '-' : ''}${Math.floor(Math.abs(value) / 100)}.${String(Math.abs(value) % 100).padStart(2, '0')}`

/** Entirely invented data. No ledger, statement, or private fixture is read. */
export function makeRows(count) {
  const rng = random(SEED)
  const rows = []
  for (let i = 0; i < count; i++) {
    // Preserve exact repeated purchases within the workbook (about 1%).
    if (i > 0 && i % 100 === 1) { rows.push({ ...rows[i - 1] }); continue }
    const bankIndex = i % 6
    const dateMs = Date.UTC(2018, 0, 1) + Math.floor(rng() * 2922) * 86400000
    const date = iso(dateMs)
    const posting = iso(dateMs + Math.floor(rng() * 4) * 86400000)
    const p = rng()
    const token = p < .82 ? '消费' : p < .88 ? '退款' : p < .95 ? '还款' : p < .98 ? '手续费' : p < .99 ? '利息' : '返现'
    const credit = ['退款', '还款', '返现'].includes(token)
    const merchant = token === '还款' ? '手机银行 自动转账还款' : token === '手续费' ? '信用卡年费 服务费' : token === '利息' ? '信用卡循环利息' : merchants[Math.floor(rng() * merchants.length)]
    const description = `${token} ${merchant}`
    const c = rng()
    const currency = c < .85 ? 'CNY' : c < .91 ? 'USD' : c < .95 ? 'HKD' : c < .98 ? 'JPY' : 'EUR'
    const settlement = currency === 'CNY' || rng() < .8 ? 'CNY' : currency
    const absolute = currency === 'JPY' ? 500 + Math.floor(rng() * 49500) : 100 + Math.floor(rng() ** 2 * (token === '还款' ? 1500000 : 200000))
    const minor = absolute * (credit ? -1 : 1)
    const fx = { CNY: 1, USD: 7.2, HKD: .92, JPY: 4.8, EUR: 7.8 }
    const settlementMinor = settlement === currency ? minor : Math.round(minor * fx[currency])
    const amount = minorString(minor, currency)
    const billed = minorString(settlementMinor, settlement)
    const card = String(bankIndex + 1).padStart(4, '0')
    const year = Number(date.slice(0, 4)), month = Number(date.slice(5, 7))
    const start = `${date.slice(0, 7)}-01`, end = iso(Date.UTC(year, month, 0))
    const sourceName = `synthetic-${bankIndex}-${date.slice(0, 7)}.eml`
    const sourceHash = createHash('sha256').update(sourceName).digest('hex')
    const rawLine = `${date.replaceAll('-', '/')} ${posting.replaceAll('-', '/')} ${card} ${description} ${currency} ${amount} ${settlement} ${billed} ${credit ? 'CR' : 'DR'}`
    const rawText = i % 10 === 0 ? `${banks[bankIndex]}信用卡账单 交易明细\n${rawLine}\n交易渠道：银联网络；本行结算，金额以入账记录为准。` : i % 10 < 4 ? description : rawLine
    const confidence = i % 40 === 0 ? .72 : .95
    rows.push({ bank: banks[bankIndex], card_last4: card, statement_start: start, statement_end: end,
      transaction_date: date, posting_date: posting, description, transaction_currency: currency,
      transaction_amount: amount, settlement_currency: settlement, settlement_amount: billed,
      source_file_name: sourceName, source_file_hash: sourceHash, confidence, raw_text: rawText,
      银行: banks[bankIndex], 卡尾号: card, 交易日: date, 入账日: posting, 说明: description,
      交易币种: currency, 交易金额: amount, 结算币种: settlement, 结算金额: billed,
      银行名称: banks[bankIndex], 卡号: `****${card}`, 交易日期: date, 入账日期: posting, 交易详情: description,
      入账币种: settlement, 入账金额: billed,
    })
  }
  return rows
}

export function makeWorkbook(rows, format = 'python', { variant = false, longRaw = false } = {}) {
  const { sheet, columns } = FORMATS[format]
  const book = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([columns, ...rows.map(row => columns.map(key => key === 'raw_text' && longRaw ? `${row.raw_text}\n`.repeat(5) : row[key]))]), sheet)
  // Workbook timestamps are fixed; XLSX ZIP timestamps are deterministic in SheetJS.
  book.Props = { Title: variant ? 'Synthetic alternate container' : 'Synthetic storage benchmark', CreatedDate: new Date('2020-01-01T00:00:00Z'), ModifiedDate: new Date('2020-01-01T00:00:00Z') }
  return Buffer.from(XLSX.write(book, { type: 'buffer', bookType: 'xlsx', compression: true }))
}

export function expectedDistribution(rows) {
  const tally = key => Object.fromEntries([...new Set(rows.map(row => row[key]))].map(value => [value, rows.filter(row => row[key] === value).length]))
  return { rows: rows.length, banks: tally('bank'), transactionCurrencies: tally('transaction_currency'), settlementCurrencies: tally('settlement_currency'),
    negativeAmounts: rows.filter(row => Number(row.settlement_amount) < 0).length,
    crossCurrency: rows.filter(row => row.transaction_currency !== row.settlement_currency).length,
    deliberateRepeatedRows: Math.floor((rows.length + 98) / 100), currencies }
}
