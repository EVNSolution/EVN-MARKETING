import { createHash } from 'node:crypto'
import { AD_SPEND_START, krwAmount, sumKrw, type AdSpendAction } from './ad-spend'
import { dashboardDate } from './external-dashboard'
import { dashboardDates, dashboardKoreaDate } from './external-dashboard-history'
import { daangnCampaign } from './ad-spend-config'
import { saveAdSpendActions } from './ad-spend-store'

export const DAANGN_CSV_MAX = 2 * 1024 * 1024
const headers = ['기간', '캠페인 이름', '캠페인 ID', '비용 (VAT 포함)', '노출 수', '도달 수', '클릭 수', '클릭률', '클릭당 비용(CPC)', '노출당 비용(CPM)']
const invalid = (): never => { throw new Error('daangn_csv_invalid') }
function csv(text: string): string[][] {
  const rows: string[][] = []; let row: string[] = [], field = '', quoted = false, closed = false
  const cell = () => { row.push(field); field = ''; closed = false; if (row.length > 10) invalid() }
  const line = () => { cell(); if (row.some(v => v !== '')) rows.push(row); row = []; if (rows.length > 367) invalid() }
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (quoted) { if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++ } else { quoted = false; closed = true } } else field += c; continue }
    if (c === ',') cell()
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; line() }
    else if (c === '"' && !field && !closed) quoted = true
    else { if (closed || c === '"') return invalid(); field += c }
    if (field.length > 1000) return invalid()
  }
  if (quoted) return invalid()
  if (field || row.length || closed) line()
  return rows
}
export function previewDaangnCsv(bytes: Uint8Array, start: string, end: string, now = new Date()) {
  if (!bytes.length || bytes.length > DAANGN_CSV_MAX) return invalid()
  const range = dashboardDates(dashboardDate(start), dashboardDate(end))
  if (start < AD_SPEND_START || end > dashboardKoreaDate(now)) return invalid()
  let text: string
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^\uFEFF/, '') } catch { return invalid() }
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text)) return invalid()
  const [head, ...source] = csv(text)
  if (!head || JSON.stringify(head.map(v => v.trim())) !== JSON.stringify(headers) || !source.length) return invalid()
  const seen = new Set<string>()
  const rows = source.map(values => {
    if (values.length !== headers.length || values.some(v => /^[=+@-]/.test(v.trim()))) return invalid()
    const [period, name, campaignId, cost] = values.map(v => v.trim())
    const match = /^(\d{4})\.(\d{2})\.(\d{2})\.$/.exec(period)
    if (!match || !name || name.length > 100 || campaignId !== daangnCampaign.campaignId) return invalid()
    const date = dashboardDate(`${match[1]}-${match[2]}-${match[3]}`)
    if (!range.includes(date) || seen.has(date) || !/^(?:0|[1-9]\d*|[1-9]\d{0,2}(?:,\d{3})+)(?:\.\d{1,12})?$/.test(cost)) return invalid()
    seen.add(date)
    return { date, amount: krwAmount(cost.replaceAll(',', '')) }
  }).sort((a, b) => a.date.localeCompare(b.date))
  return { hash: createHash('sha256').update(bytes).update(`\n${start}/${end}`).digest('hex'), start, end, campaign: 'evn 솔루션', campaignId: daangnCampaign.campaignId,
    rowCount: rows.length, missingDays: range.filter(day => !seen.has(day)), amount: sumKrw(rows.map(r => r.amount)), vat: 'included' as const, rows }
}
export async function importDaangnCsv(preview: ReturnType<typeof previewDaangnCsv>, env: { [key: string]: string | undefined; UPLOADS_DIR?: string } = process.env, now = new Date()) {
  const actions: AdSpendAction[] = [
    { type: 'configure', campaigns: [daangnCampaign] },
    { type: 'connection', provider: 'daangn', accountId: daangnCampaign.accountId, connected: true },
    { type: 'collect', provider: 'daangn', accountId: daangnCampaign.accountId, start: preview.start, end: preview.end,
      result: { rows: preview.rows.map(r => ({ ...r, campaignId: daangnCampaign.campaignId, vat: 'included', provenance: { kind: 'daangn_csv', hash: preview.hash, capturedAt: now.toISOString() } })) } },
    { type: 'import_receipt', receipt: { at: now.toISOString(), hash: preview.hash, rows: preview.rowCount, start: preview.start, end: preview.end } },
  ]
  await saveAdSpendActions(actions, env, now)
  return { importedAt: now.toISOString(), rows: preview.rowCount, missingDays: preview.missingDays.length }
}
export async function readDaangnCsvBody(request: Request) {
  if (!/^text\/csv(?:;|$)/i.test(request.headers.get('content-type') ?? '') || Number(request.headers.get('content-length') ?? 0) > DAANGN_CSV_MAX) return invalid()
  const reader = request.body?.getReader()
  if (!reader) return invalid()
  let size = 0; const chunks: Uint8Array[] = []
  try {
    while (true) { const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > DAANGN_CSV_MAX) return invalid(); chunks.push(value) }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
  return Buffer.concat(chunks)
}
