import { createHash } from 'node:crypto'
import { billingAmount, billingDate, billingHeaders, billingInvalid, billingTimestamp, billingTypes, billingWallTime, koreaDay, orderedRows, scopeKinds, type BillingRow, type BillingScope, type BillingSource } from './ad-billing'
export const BILLING_CSV_MAX = 2 * 1024 * 1024
export type BillingImportMetadata = { start: string; end: string; scope: BillingScope; capturedAt: string; confirmed: boolean }
export type BillingImport = { source: BillingSource; rows: BillingRow[] }
function parseCsv(text: string) {
  const rows: string[][] = []; let row: string[] = [], field = '', quoted = false, closed = false
  const cell = () => { row.push(field); field = ''; closed = false; if (row.length > 4) billingInvalid('원본 CSV는 정확히 4개 열이어야 합니다.') }
  const line = () => { cell(); if (row.length > 1 || row.some(v => v !== '')) rows.push(row); row = []; if (rows.length > 10001) billingInvalid('한 번에 최대 10,000건을 가져올 수 있습니다.') }
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (quoted) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++ } else { quoted = false; closed = true } } else field += c
    } else if (c === ',') cell()
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; line() }
    else if (c === '"' && !field && !closed) quoted = true
    else { if (closed || c === '"') billingInvalid('CSV 따옴표 형식을 확인해 주세요.'); field += c }
    if (field.length > 1000) billingInvalid('CSV 항목이 너무 깁니다.')
  }
  if (quoted) billingInvalid('CSV 따옴표가 닫히지 않았습니다.')
  if (field || row.length || closed) line()
  return rows
}
export function parseBillingCsv(bytes: Uint8Array, metadata: BillingImportMetadata, now = new Date()): BillingImport {
  if (!bytes.length || bytes.length > BILLING_CSV_MAX) return billingInvalid('UTF-8 CSV 파일은 2MB까지 가능합니다.')
  const { start, end, scope, capturedAt } = metadata, kinds = scopeKinds(scope)
  billingDate(start); billingDate(end); billingTimestamp(capturedAt)
  if (!metadata.confirmed) return billingInvalid('선택한 유형·조회 기간의 전체 거래내역인지 확인해 주세요.')
  if (start > end || start.slice(0, 7) !== end.slice(0, 7) || end > koreaDay(new Date(capturedAt)) || new Date(capturedAt) > now) return billingInvalid('한 달 안의 조회 기간과 실제 수집 기준시각을 확인해 주세요. 미래 자료는 가져올 수 없습니다.')
  let text: string
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^\uFEFF+/, '') } catch { return billingInvalid('UTF-8 원본 CSV를 사용해 주세요.') }
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) return billingInvalid('CSV에 허용하지 않는 제어문자가 있습니다.')
  const [header, ...rawRows] = parseCsv(text)
  if (JSON.stringify(header) !== JSON.stringify(billingHeaders)) return billingInvalid('원본 열 순서는 거래 일시,거래 유형,거래 내용,금액이어야 합니다.')
  const rows = rawRows.map(values => {
    if (values.length !== 4) return billingInvalid('모든 행은 4개 열이어야 합니다.')
    const [time, type, description, money] = values
    const match = /^(\d{4})\.(\d{2})\.(\d{2})\. ([01]\d|2[0-3]):([0-5]\d):([0-5]\d)$/.exec(time)
    if (!match) return billingInvalid('거래 일시는 YYYY.MM.DD. HH:mm:ss 형식이어야 합니다.')
    const at = billingWallTime(`${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}`), date = at.slice(0, 10)
    if (date < start || date > end) return billingInvalid('조회 기간 밖의 거래가 포함되어 있습니다.')
    // Daily spend may be stamped 23:59:59 even when captured earlier that day.
    if (type !== billingTypes.topup && type !== billingTypes.spend) return billingInvalid('환불 등 지원하지 않는 거래 유형이 있습니다. 충전·집행 원본만 선택해 주세요. 어떤 행도 제외하거나 변환하지 않았습니다.')
    if (!kinds.some(kind => billingTypes[kind] === type)) return billingInvalid('파일에 선택한 거래 유형과 다른 행이 있습니다. 전체 유형을 선택하거나 원본 파일을 확인해 주세요.')
    if (!description.trim() || description.length > 500) return billingInvalid('거래 내용을 확인해 주세요.')
    if (!/^(?:[1-9]\d*|[1-9]\d{0,2}(?:,\d{3})+)$/.test(money)) return billingInvalid('금액은 양의 정수여야 합니다. 음수·소수·환불은 지원하지 않습니다.')
    return { at, type, description, amount: billingAmount(Number(money.replaceAll(',', ''))) }
  })
  const fileHash = createHash('sha256').update(bytes).digest('hex')
  const key = createHash('sha256').update(JSON.stringify({ start, end, scope, capturedAt, fileHash })).digest('hex')
  return { source: { start, end, scope, capturedAt, fileHash, key }, rows: orderedRows(rows) }
}
export async function readBillingCsvBody(request: Request) {
  if (!/^text\/csv(?:;|$)/i.test(request.headers.get('content-type') ?? '') || Number(request.headers.get('content-length') ?? 0) > BILLING_CSV_MAX) return billingInvalid('2MB 이하의 CSV 파일을 사용해 주세요.')
  const reader = request.body?.getReader()
  if (!reader) return billingInvalid('CSV 파일이 없습니다.')
  const chunks: Uint8Array[] = []; let size = 0
  try { while (true) { const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > BILLING_CSV_MAX) return billingInvalid('CSV 파일은 2MB까지 가능합니다.'); chunks.push(value) } }
  finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
  return Buffer.concat(chunks)
}
