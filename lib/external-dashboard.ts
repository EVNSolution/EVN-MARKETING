export type DailyView = { date: string; pageViewCount: number; visitorCount: number }
export type DailyMedia = { date: string; media: string; count: number }
export type NetworkInflow = { source: string; count: number }
export type KeywordInflow = { keyword: string; count: number }
export type ExternalDashboard = {
  aggregationDates: string[]
  monthlyViews: DailyView[]
  monthlyAdViews: DailyMedia[]
  monthlyInflows: NetworkInflow[]
  monthlyKeywords: KeywordInflow[]
}
export type DashboardRecord = {
  format: 1
  source: 'mleverage-admin'
  companyScopeId: string
  homepageScopeId: string
  lastAttemptAt: string
  lastSuccessfulAt: string | null
  error: string | null
  data: ExternalDashboard | null
}

const invalid = (): never => { throw new Error('dashboard_invalid_data') }
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid()
  return value as Record<string, unknown>
}
const list = (value: unknown): unknown[] => {
  if (!Array.isArray(value) || value.length > 50_000) return invalid()
  return value
}
const count = (value: unknown): number => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) return invalid()
  return value
}
const label = (value: unknown): string => {
  if (typeof value !== 'string' || !value.trim() || value.length > 2_000) return invalid()
  return value
}
export function dashboardDate(value: unknown) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)
    || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value) return invalid()
  return value
}
const date = dashboardDate
export function parseDashboard(overview: unknown, acquisition: unknown): ExternalDashboard {
  const a = object(overview), b = object(acquisition)
  const monthlyViews = list(a.monthlyViews).map(value => {
    const row = object(value)
    return { date: date(row.date), visitorCount: count(row.visitorCount), pageViewCount: count(row.pageViewCount) }
  })
  if (new Set(monthlyViews.map(row => row.date)).size !== monthlyViews.length) return invalid()
  // This is the source's aggregation-date rule, not a locally invented date range.
  const aggregationDates = [...new Set(a.aggregationDates === undefined
    ? monthlyViews.map(row => row.date) : list(a.aggregationDates).map(date))].sort()
  if (aggregationDates.some(day => !monthlyViews.some(row => row.date === day))) return invalid()
  const monthlyAdViews = list(b.monthlyAdViews).map(value => {
    const row = object(value)
    return { date: date(row.date), media: label(row.media), count: count(row.count) }
  })
  if (new Set(monthlyAdViews.map(row => JSON.stringify([row.date, row.media]))).size !== monthlyAdViews.length) return invalid()
  const monthlyInflows = list(b.monthlyInflows).map(value => {
    const row = object(value)
    return { source: label(row.source), count: count(row.count) }
  })
  const monthlyKeywords = list(b.monthlyKeywords).map(value => {
    const row = object(value)
    return { keyword: label(row.keyword), count: count(row.count) }
  })
  for (const values of [monthlyViews.map(r => r.visitorCount), monthlyViews.map(r => r.pageViewCount), monthlyAdViews.map(r => r.count), monthlyInflows.map(r => r.count), monthlyKeywords.map(r => r.count)]) {
    count(values.reduce((sum, value) => sum + value, 0))
  }
  return { aggregationDates, monthlyViews, monthlyAdViews, monthlyInflows, monthlyKeywords }
}

export function dashboardResponseBody(value: unknown) {
  const response = object(value)
  const result = object(response.result)
  if (result.success !== true) throw new Error(result.code === 'ERR-AUT001' ? 'dashboard_login_required' : 'dashboard_source_error')
  return object(response.body)
}

export function dashboardTotals(data: ExternalDashboard) {
  if (!data.aggregationDates.length) return { visitors: null, pageviews: null }
  const dates = new Set(data.aggregationDates)
  return data.monthlyViews.filter(row => dates.has(row.date)).reduce((total, row) => ({
    visitors: total.visitors + row.visitorCount, pageviews: total.pageviews + row.pageViewCount,
  }), { visitors: 0, pageviews: 0 })
}

// The source allocates rounding remainders at one decimal place, separately per ranking.
export function dashboardPercentages(values: number[]) {
  const total = values.reduce((sum, value) => sum + value, 0)
  if (total === 0) return values.map(() => 0)
  const raw = values.map(value => value / total * 100 * 10)
  const tenths = raw.map(Math.floor)
  let remainder = 1_000 - tenths.reduce((sum, value) => sum + value, 0)
  const order = raw.map((value, index) => ({ index, fraction: value - Math.floor(value) }))
    .sort((a, b) => b.fraction - a.fraction || a.index - b.index)
  for (let i = 0; remainder > 0; i++, remainder--) tenths[order[i % order.length].index]++
  return tenths.map(value => value / 10)
}

export function mediaLabel(media: string) {
  const value = media.toLowerCase()
  const rules: [string, string[]][] = [
    ['네이버', ['네이버', 'naver']], ['구글', ['구글', 'google']],
    ['카카오', ['카카오', 'kakao']], ['당근', ['당근', 'karrot', 'danggeun']],
    ['메타', ['메타', 'facebook', 'insta']], ['모비온', ['모비온']],
    ['타불라', ['타불라', 'taboola']], ['토스', ['토스', 'toss']],
  ]
  return rules.find(([, names]) => names.some(name => value.includes(name)))?.[0] ?? media
}

export const dashboardErrorText: Record<string, string> = {
  dashboard_login_required: '원본 서비스 로그인이 필요합니다.',
  dashboard_source_error: '원본 대시보드를 불러오지 못했습니다.',
  dashboard_invalid_data: '원본의 일부 수치가 누락되었거나 형식이 변경되었습니다.',
  dashboard_scope: '원본 대시보드의 홈페이지 범위를 확인하지 못했습니다.',
  dashboard_timeout: '원본 대시보드 응답 시간이 초과되었습니다.',
  dashboard_interrupted: '수집이 중단되었습니다. 다음 수집 시 다시 확인합니다.',
  dashboard_storage_error: '수집 결과를 저장하지 못했습니다.',
}
