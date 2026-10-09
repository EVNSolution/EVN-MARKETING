import { dashboardDate, parseDashboard, type DailyMedia, type DailyView, type DashboardRecord, type ExternalDashboard } from './external-dashboard'

export type ObservedView = DailyView & { collectedAt: string }
export type ObservedMedia = DailyMedia & { collectedAt: string }
export type DashboardDay = { date: string; view: ObservedView | null; media: ObservedMedia[] }
export type DashboardHistory = { format: 1; days: DashboardDay[]; latest: DashboardRecord }
export type DashboardQuery = { start?: string; end?: string; snapshot?: string }
export type DashboardHistoryView = {
  today: string; start: string | null; end: string | null; filtered: boolean
  availableStart: string | null; availableEnd: string | null
  days: DashboardDay[]; data: ExternalDashboard; missingDays: string[]; missingMediaDays: string[]
  snapshot: DashboardRecord | null; snapshotDays: string[]; persisted: boolean
}
const invalid = (): never => { throw new Error('dashboard_storage_error') }
export function dashboardTimestamp(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value
}
export function dashboardKoreaDate(now = new Date()) {
  return new Date(now.getTime() + 9 * 3_600_000).toISOString().slice(0, 10)
}
export function dashboardDates(start: string, end: string) {
  const length = (Date.parse(end) - Date.parse(start)) / 86_400_000 + 1
  if (!Number.isInteger(length) || length < 1 || length > 366) throw new Error('dashboard_invalid_range')
  return Array.from({ length }, (_, i) => new Date(Date.parse(start) + i * 86_400_000).toISOString().slice(0, 10))
}
export function parseDashboardQuery(params: URLSearchParams, now = new Date()): DashboardQuery {
  try {
    for (const key of params.keys()) if (!['start', 'end', 'snapshot'].includes(key) || params.getAll(key).length !== 1) throw new Error()
    const query: DashboardQuery = {}
    for (const key of ['start', 'end', 'snapshot'] as const) if (params.has(key)) {
      query[key] = dashboardDate(params.get(key))
      if (query[key]! > dashboardKoreaDate(now)) throw new Error()
    }
    if (Boolean(query.start) !== Boolean(query.end)) throw new Error()
    if (query.start && query.end) dashboardDates(query.start, query.end)
    return query
  } catch { throw new Error('dashboard_invalid_range') }
}

export function parseHistoryDays(value: unknown): DashboardDay[] {
  if (!Array.isArray(value) || value.length > 50_000) return invalid()
  const days = value.map((item): DashboardDay => {
    if (!item || typeof item !== 'object') return invalid()
    const day = dashboardDate(item.date)
    if (!Array.isArray(item.media) || (item.view !== null && (!item.view || typeof item.view !== 'object'))) return invalid()
    const parsed = parseDashboard({ monthlyViews: item.view ? [item.view] : [] }, {
      monthlyAdViews: item.media, monthlyInflows: [], monthlyKeywords: [],
    })
    if (parsed.monthlyViews.some(row => row.date !== day) || parsed.monthlyAdViews.some(row => row.date !== day)
      || (item.view && !dashboardTimestamp(item.view.collectedAt))
      || item.media.some((row: ObservedMedia) => !dashboardTimestamp(row.collectedAt))) return invalid()
    return { date: day, view: item.view ? { ...parsed.monthlyViews[0], collectedAt: item.view.collectedAt } : null,
      media: parsed.monthlyAdViews.map((row, index) => ({ ...row, collectedAt: item.media[index].collectedAt })) }
  })
  if (new Set(days.map(day => day.date)).size !== days.length) return invalid()
  return days.sort((a, b) => a.date.localeCompare(b.date))
}

// Only explicitly dated source values are observations. Absence never means zero or deletion.
export function mergeDashboardHistory(previous: DashboardHistory | null, record: DashboardRecord): DashboardHistory | null {
  if (!record.data || !record.lastSuccessfulAt) return previous
  const collectedAt = record.lastSuccessfulAt
  const days = new Map((previous?.days ?? []).map(day => [day.date, { ...day, media: [...day.media] }]))
  const get = (date: string) => {
    if (!days.has(date)) days.set(date, { date, view: null, media: [] })
    return days.get(date)!
  }
  const aggregated = new Set(record.data.aggregationDates)
  for (const row of record.data.monthlyViews) {
    if (!aggregated.has(row.date)) continue
    const day = get(row.date)
    if (!day.view || day.view.collectedAt <= collectedAt) day.view = { ...row, collectedAt }
  }
  for (const row of record.data.monthlyAdViews) {
    const day = get(row.date)
    const index = day.media.findIndex(item => item.media === row.media)
    if (index < 0) day.media.push({ ...row, collectedAt })
    else if (day.media[index].collectedAt <= collectedAt) day.media[index] = { ...row, collectedAt }
  }
  const latest = previous?.latest.lastSuccessfulAt && previous.latest.lastSuccessfulAt > collectedAt
    ? previous.latest : { ...record, lastAttemptAt: collectedAt, error: null }
  return { format: 1, days: [...days.values()].sort((a, b) => a.date.localeCompare(b.date)), latest }
}

export function selectDashboardHistory(history: DashboardHistory | null, record: DashboardRecord | null,
  query: DashboardQuery, snapshot: DashboardRecord | null, snapshotDays: string[], persisted: boolean, now = new Date()): DashboardHistoryView {
  const sourceDates = record?.data?.aggregationDates ?? history?.latest.data?.aggregationDates ?? []
  const start = query.start ?? sourceDates[0] ?? null, end = query.end ?? sourceDates.at(-1) ?? null
  const selected = start && end ? dashboardDates(start, end) : []
  const byDate = new Map(history?.days.map(day => [day.date, day]) ?? [])
  const days = selected.map(date => byDate.get(date) ?? { date, view: null, media: [] })
  const views = days.flatMap(day => day.view ? [{ date: day.date, visitorCount: day.view.visitorCount, pageViewCount: day.view.pageViewCount }] : [])
  const data = parseDashboard({ aggregationDates: views.map(row => row.date), monthlyViews: views }, {
    monthlyAdViews: days.flatMap(day => day.media.map(({ date, media, count }) => ({ date, media, count }))),
    monthlyInflows: [], monthlyKeywords: [],
  })
  return { today: dashboardKoreaDate(now), start, end, filtered: Boolean(query.start),
    availableStart: history?.days[0]?.date ?? null, availableEnd: history?.days.at(-1)?.date ?? null,
    days, data, missingDays: days.filter(day => !day.view).map(day => day.date), missingMediaDays: days.filter(day => !day.media.length).map(day => day.date),
    snapshot, snapshotDays, persisted }
}
