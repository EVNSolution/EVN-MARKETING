// Accounting ledger only. Top-ups and spend are separate totals, never a combined cost.
export const billingKinds = ['topup', 'spend'] as const
export type BillingKind = typeof billingKinds[number]
export type BillingScope = BillingKind | 'both'
export const billingTypes = { topup: '유상캐시 충전', spend: '광고캐시 사용' } as const
export const billingLabels = { topup: '충전내역', spend: '집행내역' } as const
export const billingHeaders = ['거래 일시', '거래 유형', '거래 내용', '금액']
// Excel preserves at most 15 significant decimal digits. Reject, never round.
export const BILLING_MAX_AMOUNT = 999_999_999_999_999
export const BILLING_MAX_ROWS = 20_000
export class BillingError extends Error {
  constructor(public code: string, message: string, public status = 400) { super(message) }
}
export function billingInvalid(message = '정산 자료의 형식을 확인해 주세요.'): never { throw new BillingError('invalid', message) }
export type BillingRow = { at: string; type: typeof billingTypes[BillingKind]; description: string; amount: number }
export type BillingSource = { start: string; end: string; scope: BillingScope; capturedAt: string; fileHash: string; key: string }
export type BillingDay = { date: string; kind: BillingKind; rows: BillingRow[]; source: BillingSource; importedAt: string }
export type BillingRecord = { format: 1; month: string; days: BillingDay[] }
export function billingDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || value < '2000-01-01' || value > '9999-12-31') return billingInvalid('날짜를 확인해 주세요.')
  const date = new Date(`${value}T00:00:00.000Z`)
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) return billingInvalid('존재하지 않는 날짜입니다.')
  return value
}
export function billingMonth(value: string) {
  if (!/^\d{4}-\d{2}$/.test(value)) return billingInvalid('정산 월을 확인해 주세요.')
  billingDate(`${value}-01`); return value
}
export function koreaDay(now = new Date()) { return new Date(now.getTime() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10) }
export function previousBillingMonth(now = new Date()) {
  const [year, month] = koreaDay(now).split('-').map(Number)
  return new Date(Date.UTC(year, month - 2, 1)).toISOString().slice(0, 7)
}
export function monthDays(month: string) {
  billingMonth(month)
  const [year, n] = month.split('-').map(Number), count = new Date(Date.UTC(year, n, 0)).getUTCDate()
  return Array.from({ length: count }, (_, i) => `${month}-${String(i + 1).padStart(2, '0')}`)
}
export function billingTimestamp(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) return billingInvalid('수집 기준시각을 확인해 주세요.')
  billingDate(value.slice(0, 10)); return value
}
export function billingWallTime(value: string) {
  const match = /^(\d{4}-\d{2}-\d{2})T([01]\d|2[0-3]):([0-5]\d):([0-5]\d)$/.exec(value)
  if (!match) return billingInvalid('거래 일시는 YYYY.MM.DD. HH:mm:ss 형식이어야 합니다.')
  billingDate(match[1]); return value
}
export function billingAmount(value: number) {
  if (!Number.isSafeInteger(value) || value < 0 || value > BILLING_MAX_AMOUNT) return billingInvalid('금액은 엑셀에서 정확히 표현할 수 있는 15자리 이하 정수여야 합니다.')
  return value
}
export function billingSum(rows: BillingRow[]) { return rows.reduce((total, row) => billingAmount(total + billingAmount(row.amount)), 0) }
export function scopeKinds(scope: BillingScope): readonly BillingKind[] {
  if (scope === 'both') return billingKinds
  if (billingKinds.includes(scope)) return [scope]
  return billingInvalid('충전·집행·전체 중 파일의 거래 유형을 선택해 주세요.')
}
export function emptyBilling(month: string): BillingRecord { return { format: 1, month: billingMonth(month), days: [] } }
export function orderedRows(rows: BillingRow[]) { return [...rows].sort((a, b) => b.at.localeCompare(a.at) || a.type.localeCompare(b.type) || a.description.localeCompare(b.description) || a.amount - b.amount) }
export function billingRanges(dates: string[]) {
  const ranges: { start: string; end: string }[] = []
  for (const date of [...dates].sort()) {
    const last = ranges.at(-1)
    if (last && Date.parse(`${date}T00:00:00Z`) - Date.parse(`${last.end}T00:00:00Z`) === 86400000) last.end = date
    else ranges.push({ start: date, end: date })
  }
  return ranges
}
export function selectBilling(record: BillingRecord, now = new Date()) {
  const dates = monthDays(record.month)
  const summaries = billingKinds.map(kind => {
    const days = record.days.filter(day => day.kind === kind), rows = orderedRows(days.flatMap(day => day.rows))
    const complete = days.filter(day => day.date < koreaDay(new Date(day.source.capturedAt))).map(day => day.date)
    const missing = dates.filter(date => !days.some(day => day.date === date))
    const partial = days.filter(day => !complete.includes(day.date)).map(day => day.date)
    return { kind, count: days.length ? rows.length : null, total: days.length ? billingSum(rows) : null,
      coveredDays: days.length, completeDays: complete.length, missingDays: missing, partialDays: partial,
      ranges: billingRanges(days.map(day => day.date)), completeRanges: billingRanges(complete),
      capturedAt: days.map(day => day.source.capturedAt).sort().at(-1) ?? null,
      importedAt: days.map(day => day.importedAt).sort().at(-1) ?? null }
  })
  return { month: record.month, dayCount: dates.length, closed: record.month < koreaDay(now).slice(0, 7),
    ready: record.month < koreaDay(now).slice(0, 7) && summaries.every(v => v.completeDays === dates.length),
    summaries }
}
export type BillingView = ReturnType<typeof selectBilling> & { revision: string }

// Reject corrupt stored data rather than presenting an invented zero or overwriting it.
export function parseBillingRecord(value: unknown, month: string): BillingRecord {
  try {
    if (!value || typeof value !== 'object') throw Error()
    const record = value as BillingRecord
    if (record.format !== 1 || record.month !== billingMonth(month) || !Array.isArray(record.days) || record.days.length > 62) throw Error()
    const keys = new Set<string>(); let rowCount = 0
    for (const day of record.days) {
      billingDate(day.date)
      if (!billingKinds.includes(day.kind) || day.date.slice(0, 7) !== month || keys.has(day.date + day.kind)) throw Error()
      keys.add(day.date + day.kind)
      billingTimestamp(day.importedAt)
      const source = day.source
      billingTimestamp(source.capturedAt); billingDate(source.start); billingDate(source.end)
      if (source.start.slice(0, 7) !== month || source.end.slice(0, 7) !== month || source.start > day.date || source.end < day.date || source.end > koreaDay(new Date(source.capturedAt)) || source.capturedAt > day.importedAt || !scopeKinds(source.scope).includes(day.kind) || !/^[a-f0-9]{64}$/.test(source.key) || !/^[a-f0-9]{64}$/.test(source.fileHash)) throw Error()
      if (!Array.isArray(day.rows) || (rowCount += day.rows.length) > BILLING_MAX_ROWS) throw Error()
      for (const row of day.rows) {
        billingWallTime(row.at); billingAmount(row.amount)
        if (row.amount === 0 || row.at.slice(0, 10) !== day.date || row.type !== billingTypes[day.kind] || typeof row.description !== 'string' || !row.description.trim() || row.description.length > 500 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(row.description)) throw Error()
      }
    }
    for (const kind of billingKinds) billingSum(record.days.filter(day => day.kind === kind).flatMap(day => day.rows))
    return record
  } catch { throw new BillingError('storage', '저장된 정산 자료를 확인하지 못했습니다. 기존 자료를 유지하며 관리자 확인이 필요합니다.', 503) }
}
