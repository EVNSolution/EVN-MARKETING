import { createHmac } from 'node:crypto'
import { AD_SPEND_START, krwAmount, type AdCampaign } from './ad-spend'
import { dashboardDate } from './external-dashboard'
import { dashboardDates, dashboardKoreaDate } from './external-dashboard-history'

// Root DailyStatResponse envelope verified by the control tower. Not wired to a worker or credentials.
type RequestScope = { customerId: string; campaignId: string; start: string; end: string; allowlist: AdCampaign[] }
type Credentials = { apiKey: string; secretKey: string }
export type NaverCampaignSpend = { provider: 'naver'; accountId: string; campaignId: string; start: string; end: string; rows: { date: string; campaignId: string; amount: string; vat: 'included' }[] }
const invalid = (): never => { throw new Error('naver_ads_invalid_response') }
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : invalid()
const maxBytes = 1024 * 1024
function scopeDates(scope: RequestScope, now: Date) {
  const start = dashboardDate(scope.start), end = dashboardDate(scope.end), dates = dashboardDates(start, end)
  const allowed = scope.allowlist.find(c => c.provider === 'naver' && c.accountId === scope.customerId && c.campaignId === scope.campaignId)
  if (!/^\d+$/.test(scope.customerId) || !/^cmp-[A-Za-z0-9-]+$/.test(scope.campaignId) || !allowed
    || start < AD_SPEND_START || start < allowed.start || (allowed.end && end > allowed.end)
    || end > dashboardKoreaDate(now) || dates.length > 92) throw new Error('naver_ads_invalid_scope')
  return dates
}
export function parseNaverDailyStats(text: string, scope: RequestScope, now = new Date()): NaverCampaignSpend {
  const dates = new Set(scopeDates(scope, now)), seen = new Set<string>()
  if (Buffer.byteLength(text) > maxBytes) return invalid()
  try {
    // ES2024 source text retains int64 precision before JSON's Number conversion.
    // Older runtimes reject unsafe values rather than silently round them.
    const raw: unknown = JSON.parse(text, (key, value: unknown, context?: { source?: string }) => {
      if (key !== 'salesAmt' || typeof value !== 'number') return value
      if (context?.source) return context.source
      return Number.isSafeInteger(value) ? String(value) : invalid()
    })
    const daily = object(raw), summary = object(daily.summary)
    if (daily.dailyStatResponse !== undefined || daily.summaryStatResponse !== undefined || !Array.isArray(daily.data) || daily.data.length > dates.size
      || summary.dateStart !== scope.start || summary.dateEnd !== scope.end || typeof daily.cycleBaseTm !== 'string'
      || !/^\d{12}$/.test(daily.cycleBaseTm)) return invalid()
    const rows = daily.data.map(item => {
      const row = object(item), date = dashboardDate(row.dateStart)
      if (row.dateEnd !== date || !dates.has(date) || seen.has(date) || (row.id !== undefined && row.id !== scope.campaignId)) return invalid()
      seen.add(date)
      const amount = krwAmount(row.salesAmt)
      if (!/^\d+$/.test(amount) || BigInt(amount) > BigInt('9223372036854775807')) return invalid()
      return { date, campaignId: scope.campaignId, amount, vat: 'included' as const }
    })
    // The producer must combine ALL allowed campaigns for this account/range before one store action.
    return { provider: 'naver', accountId: scope.customerId, campaignId: scope.campaignId, start: scope.start, end: scope.end, rows }
  } catch { return invalid() }
}
export async function fetchNaverDailyStats(scope: RequestScope, credentials: Credentials, request: typeof fetch = fetch, now = new Date(), signal?: AbortSignal) {
  scopeDates(scope, now)
  if (!credentials.apiKey || !credentials.secretKey) throw new Error('naver_ads_not_connected')
  const timestamp = String(now.getTime()), uri = '/stats', url = new URL(uri, 'https://api.searchad.naver.com')
  url.search = new URLSearchParams({ id: scope.campaignId, fields: JSON.stringify(['salesAmt', 'impCnt', 'clkCnt']),
    timeRange: JSON.stringify({ since: scope.start, until: scope.end }), timeIncrement: '1' }).toString()
  const signature = createHmac('sha256', credentials.secretKey).update(`${timestamp}.GET.${uri}`).digest('base64')
  const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 10_000)
  try {
    const response = await request(url, { method: 'GET', redirect: 'error', cache: 'no-store', signal: signal ? AbortSignal.any([signal, controller.signal]) : controller.signal, headers: {
      'X-Timestamp': timestamp, 'X-API-KEY': credentials.apiKey, 'X-Customer': scope.customerId, 'X-Signature': signature,
    } })
    if (response.status === 401 || response.status === 403) throw new Error('naver_ads_authentication_required')
    if (!response.ok || response.redirected || !response.body || Number(response.headers.get('content-length') ?? 0) > maxBytes) throw new Error('naver_ads_fetch_failed')
    const reader = response.body.getReader(), chunks: Uint8Array[] = []
    let length = 0
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        length += value.byteLength
        if (length > maxBytes) return invalid()
        chunks.push(value)
      }
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
    return parseNaverDailyStats(Buffer.concat(chunks).toString('utf8'), scope, now)
  } catch (error) {
    const allowed = ['naver_ads_invalid_response', 'naver_ads_authentication_required']
    throw new Error(error instanceof Error && allowed.includes(error.message) ? error.message : 'naver_ads_fetch_failed')
  } finally { clearTimeout(timeout) }
}
