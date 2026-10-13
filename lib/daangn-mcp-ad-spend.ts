import { createHash } from 'node:crypto'
import { AD_SPEND_START, krwAmount, sumKrw, type AdSpendAction } from './ad-spend'
import { daangnCampaign } from './ad-spend-config'
import { dashboardDate } from './external-dashboard'
import { dashboardDates, dashboardKoreaDate, dashboardTimestamp } from './external-dashboard-history'
import { saveAdSpendActions } from './ad-spend-store'

export const DAANGN_MCP_MAX = 2 * 1024 * 1024
const invalid = (): never => { throw new Error('daangn_mcp_invalid') }
function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid()
  const result = value as Record<string, unknown>
  if (Object.keys(result).length !== keys.length || keys.some(key => !Object.hasOwn(result, key))) return invalid()
  return result
}
const integer = (value: unknown) => typeof value === 'string' && /^(0|[1-9]\d{0,29})$/.test(value) ? krwAmount(value) : invalid()
const string = (value: unknown, maximum: number) => typeof value === 'string' && value.trim() && value.length <= maximum && !/[\u0000-\u001f]/.test(value) ? value : invalid()
function cutoff(today: string) {
  const [year, month, day] = today.split('-').map(Number)
  const first = new Date(Date.UTC(year, month - 14, 1))
  const last = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate()
  first.setUTCDate(Math.min(day, last))
  return [AD_SPEND_START, first.toISOString().slice(0, 10)].sort().at(-1)!
}

// This validates an admin-supplied transcript; it is not a cryptographic attestation from Daangn.
// Only the control-tower-verified single-day ALL response is accepted. No inferred missing-day zeros.
export function previewDaangnMcp(bytes: Uint8Array, now = new Date()) {
  if (!bytes.length || bytes.length > DAANGN_MCP_MAX) return invalid()
  let input: unknown
  try { input = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) } catch { return invalid() }
  const envelope = object(input, ['version', 'source', 'fetchedAt', 'reports'])
  if (envelope.version !== 1 || envelope.source !== 'daangn_mcp' || !dashboardTimestamp(envelope.fetchedAt)
    || Date.parse(envelope.fetchedAt) > now.getTime() || !Array.isArray(envelope.reports) || envelope.reports.length < 1 || envelope.reports.length > 31) return invalid()
  const fetchedAt = envelope.fetchedAt, today = dashboardKoreaDate(now), fetchedDay = dashboardKoreaDate(new Date(fetchedAt))
  const seen = new Set<string>()
  const days = envelope.reports.map(item => {
    const report = object(item, ['request', 'response'])
    const request = object(report.request, ['advertiser_id', 'advertiser_request', 'start_date', 'end_date', 'metrics', 'structure', 'page', 'page_size'])
    const date = dashboardDate(request.start_date)
    if (request.advertiser_id !== daangnCampaign.accountId || date !== request.end_date || date < cutoff(today)
      || date >= today || date >= fetchedDay || seen.has(date) || request.page !== 1 || request.page_size !== 1
      || JSON.stringify(request.metrics) !== '["COST"]' || !Array.isArray(request.structure) || request.structure.length !== 1) return invalid()
    string(request.advertiser_request, 200)
    const scope = object(request.structure[0], ['type', 'filter', 'grouping'])
    if (scope.type !== 'campaign' || scope.grouping !== true || JSON.stringify(scope.filter) !== JSON.stringify([daangnCampaign.campaignId])) return invalid()
    const response = object(report.response, ['totals', 'rows', 'has_more', 'applied'])
    const applied = object(response.applied, ['start_date', 'end_date', 'duration', 'page', 'page_size', 'sort'])
    if (response.has_more !== false || applied.start_date !== date || applied.end_date !== date || applied.duration !== 'ALL'
      || applied.page !== 1 || applied.page_size !== 1 || applied.sort !== null || !Array.isArray(response.rows) || response.rows.length > 1) return invalid()
    const total = integer(object(response.totals, ['COST']).COST)
    seen.add(date)
    if (!response.rows.length) {
      if (total !== '0') return invalid()
      return { date, amount: null }
    }
    const row = object(response.rows[0], ['analysis_items', 'metrics'])
    const campaign = object(object(row.analysis_items, ['CAMPAIGN']).CAMPAIGN, ['id', 'name'])
    if (campaign.id !== daangnCampaign.campaignId) return invalid()
    string(campaign.name, 100)
    const amount = integer(object(row.metrics, ['COST']).COST)
    if (amount !== total) return invalid()
    return { date, amount }
  }).sort((a, b) => a.date.localeCompare(b.date))
  // A batch spans at most 31 calendar days as well as containing at most 31 single-day responses.
  if (dashboardDates(days[0].date, days.at(-1)!.date).length > 31) return invalid()
  const rows = days.filter((day): day is { date: string; amount: string } => day.amount !== null)
  return { source: 'daangn_mcp' as const, hash: createHash('sha256').update(bytes).digest('hex'), fetchedAt,
    start: days[0].date, end: days.at(-1)!.date, days, rows, rowCount: rows.length,
    missingDays: days.filter(day => day.amount === null).map(day => day.date),
    amount: rows.length ? sumKrw(rows.map(row => row.amount)) : null, vat: 'unknown' as const }
}

export async function importDaangnMcp(bytes: Uint8Array, expectedHash: string, env: { [key: string]: string | undefined; UPLOADS_DIR?: string } = process.env, now = new Date()) {
  const preview = previewDaangnMcp(bytes, now)
  if (expectedHash !== preview.hash) throw new Error('daangn_mcp_changed')
  const actions: AdSpendAction[] = [
    { type: 'configure', campaigns: [daangnCampaign] },
    { type: 'connection', provider: 'daangn', accountId: daangnCampaign.accountId, connected: true },
    ...preview.days.map((day): AdSpendAction => ({ type: 'collect', provider: 'daangn', accountId: daangnCampaign.accountId, start: day.date, end: day.date,
      result: { rows: day.amount === null ? [] : [{ date: day.date, amount: day.amount, campaignId: daangnCampaign.campaignId, vat: 'unknown',
        provenance: { kind: 'daangn_mcp', hash: preview.hash, capturedAt: preview.fetchedAt } }] } })),
    { type: 'mcp_receipt', receipt: { at: now.toISOString(), hash: preview.hash, rows: preview.rowCount, start: preview.start, end: preview.end } },
  ]
  // Using acquisition time prevents replayed older transcripts from replacing a newer successful value.
  await saveAdSpendActions(actions, env, new Date(preview.fetchedAt))
  return { importedAt: now.toISOString(), rows: preview.rowCount, missingDays: preview.missingDays.length, source: preview.source }
}

export async function readDaangnMcpBody(request: Request) {
  if (!/^application\/json(?:;|$)/i.test(request.headers.get('content-type') ?? '') || Number(request.headers.get('content-length') ?? 0) > DAANGN_MCP_MAX) return invalid()
  const reader = request.body?.getReader()
  if (!reader) return invalid()
  let size = 0; const chunks: Uint8Array[] = []
  try {
    while (true) { const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > DAANGN_MCP_MAX) return invalid(); chunks.push(value) }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
  return Buffer.concat(chunks)
}
