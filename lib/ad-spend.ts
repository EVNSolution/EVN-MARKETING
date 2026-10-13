import { dashboardDate } from './external-dashboard'
import { dashboardDates, dashboardKoreaDate, dashboardTimestamp } from './external-dashboard-history'

export const AD_SPEND_START = '2026-09-11'
export const adProviders = ['naver', 'daangn'] as const
export type AdProvider = typeof adProviders[number]
export type VatBasis = 'included' | 'excluded' | 'unknown'
export const adProviderLabels = { naver: '네이버 파워링크', daangn: '당근 비즈니스' }
export const vatLabels = { included: '부가세 포함', excluded: '부가세 제외', unknown: '부가세 미확인' }
type Identity = { provider: AdProvider; accountId: string; campaignId: string }
export type AdCampaign = Identity & { start: string; end: string | null; lifecycle: 'active' | 'paused' | 'deleted' }
type Account = { provider: AdProvider; accountId: string; connected: boolean }
export type AdSpendProvenance = { kind: 'daangn_csv' | 'daangn_mcp'; hash: string; capturedAt: string; vatEvidence?: { observedAt: string; hash: string | null } }
export type AdSpendRow = Identity & { date: string; amount: string | null; vat: VatBasis | null; observedAt: string | null; attemptedAt: string; issue: 'missing' | 'fetch_failed' | 'authentication_required' | null; provenance?: AdSpendProvenance }
export type ImportReceipt = { at: string; hash: string; rows: number; start: string; end: string }
export type AdSpendRecord = { format: 1; campaigns: AdCampaign[]; accounts: Account[]; rows: AdSpendRow[]; lastDaangnImport: ImportReceipt | null; lastDaangnMcpImport?: ImportReceipt | null }
export type AdSpendAction = { type: 'import_receipt' | 'mcp_receipt'; receipt: ImportReceipt } | { type: 'configure'; campaigns: AdCampaign[] } | { type: 'connection'; provider: AdProvider; accountId: string; connected: boolean } | {
  type: 'collect'; provider: AdProvider; accountId: string; start: string; end: string
  result: { rows: { date: string; campaignId: string; amount: string; vat: VatBasis; provenance?: AdSpendProvenance }[]; error?: never }
    | { error: 'fetch_failed' | 'authentication_required'; rows?: never }
}
export type SpendStatus = 'complete' | 'provisional' | 'disconnected' | 'scope_missing' | 'missing' | 'partial' | 'error' | 'tax_unconfirmed' | 'out_of_scope'
export const spendStatusLabels: Record<SpendStatus, string> = { complete: '수집 완료', provisional: '오늘 포함 · 진행 중인 부분 집계', disconnected: '미연결', scope_missing: 'EVN 캠페인 지정 대기', missing: '미수집', partial: '일부 누락 · 보관 값', error: '수집 오류', tax_unconfirmed: '세금 기준 확인 필요', out_of_scope: '집계 대상 기간 아님' }
export type SpendSummary = { total: string | null; vat: VatBasis | null; groups: { vat: VatBasis; amount: string }[]; status: SpendStatus; expected: number; observed: number; lastSuccessfulAt: string | null; lastAttemptAt: string | null }
export type AdSpendView = { start: string; end: string; availableFrom: string; currency: 'KRW'; lastDaangnImport: Omit<ImportReceipt, 'hash'> | null; lastDaangnMcpImport?: Omit<ImportReceipt, 'hash'> | null; total: SpendSummary; providers: Record<AdProvider, SpendSummary>; days: { date: string; total: SpendSummary; providers: Record<AdProvider, SpendSummary> }[] }
const invalid = (): never => { throw new Error('ad_spend_invalid_data') }
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : invalid()
const id = (value: unknown) => typeof value === 'string' && /^[A-Za-z0-9_-]{1,160}$/.test(value) ? value : invalid()
const provider = (value: unknown): AdProvider => adProviders.includes(value as AdProvider) ? value as AdProvider : invalid()
const vat = (value: unknown): VatBasis => ['included', 'excluded', 'unknown'].includes(value as string) ? value as VatBasis : invalid()
const date = (value: unknown) => { const result = dashboardDate(value); return result >= AD_SPEND_START ? result : invalid() }
const key = (item: Identity) => JSON.stringify([item.provider, item.accountId, item.campaignId])
const rowKey = (item: Identity & { date: string }) => JSON.stringify([item.date, key(item)])
const accountKey = (item: Account | Identity) => JSON.stringify([item.provider, item.accountId])
const applies = (campaign: AdCampaign, day: string) => campaign.start <= day && (!campaign.end || campaign.end >= day)
const identity = (value: Record<string, unknown>): Identity => ({ provider: provider(value.provider), accountId: id(value.accountId), campaignId: id(value.campaignId) })
export const emptyAdSpend = (): AdSpendRecord => ({ format: 1, campaigns: [], accounts: [], rows: [], lastDaangnImport: null })
function receipt(value: unknown, mcp = false): ImportReceipt {
  const v = object(value), start = date(v.start), end = date(v.end)
  dashboardDates(start, end)
  if (!dashboardTimestamp(v.at) || typeof v.hash !== 'string' || !/^[a-f0-9]{64}$/.test(v.hash) || !Number.isInteger(v.rows) || Number(v.rows) < (mcp ? 0 : 1) || Number(v.rows) > (mcp ? 31 : 366)) return invalid()
  return { at: v.at, hash: v.hash, rows: Number(v.rows), start, end }
}
function provenance(value: unknown, source: AdProvider, observedAt: string | null): AdSpendProvenance {
  const v = object(value)
  if (source !== 'daangn' || !['daangn_csv', 'daangn_mcp'].includes(v.kind as string)
    || typeof v.hash !== 'string' || !/^[a-f0-9]{64}$/.test(v.hash)
    || !dashboardTimestamp(v.capturedAt) || !observedAt || v.capturedAt > observedAt) return invalid()
  let vatEvidence: AdSpendProvenance['vatEvidence']
  if (v.vatEvidence !== undefined) {
    const evidence = object(v.vatEvidence)
    if (v.kind !== 'daangn_mcp' || !dashboardTimestamp(evidence.observedAt) || evidence.observedAt > v.capturedAt
      || (evidence.hash !== null && (typeof evidence.hash !== 'string' || !/^[a-f0-9]{64}$/.test(evidence.hash)))) return invalid()
    vatEvidence = { observedAt: evidence.observedAt, hash: evidence.hash as string | null }
  }
  return { kind: v.kind as AdSpendProvenance['kind'], hash: v.hash, capturedAt: v.capturedAt, ...(vatEvidence ? { vatEvidence } : {}) }
}

// Never coerce provider amounts through Number. Preserve original decimal scale in storage.
export function krwAmount(value: unknown): string {
  return typeof value === 'string' && /^(0|[1-9]\d{0,29})(\.\d{1,12})?$/.test(value) ? value : invalid()
}
export function sumKrw(values: string[]): string {
  const parsed = values.map(krwAmount), scale = parsed.reduce((n, value) => Math.max(n, value.split('.')[1]?.length ?? 0), 0)
  const total = parsed.reduce((sum, value) => { const [whole, fraction = ''] = value.split('.'); return sum + BigInt(whole + fraction.padEnd(scale, '0')) }, BigInt(0))
  const digits = total.toString().padStart(scale + 1, '0')
  return scale ? digits.slice(0, -scale) + '.' + digits.slice(-scale) : digits
}
export function formatKrw(value: string | null): string {
  if (value === null) return '—'
  const [whole, fraction] = value.split('.')
  return whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + (fraction === undefined ? '' : '.' + fraction) + '원'
}
function campaign(value: unknown): AdCampaign {
  const v = object(value), start = date(v.start), end = v.end === null ? null : date(v.end)
  if ((end && end < start) || !['active', 'paused', 'deleted'].includes(v.lifecycle as string)) return invalid()
  return { ...identity(v), start, end, lifecycle: v.lifecycle as AdCampaign['lifecycle'] }
}
export function parseAdSpendRecord(value: unknown): AdSpendRecord {
  const v = object(value)
  if (v.format !== 1 || !Array.isArray(v.campaigns) || !Array.isArray(v.accounts) || !Array.isArray(v.rows)
    || v.campaigns.length > 1000 || v.accounts.length > 1000 || v.rows.length > 200_000) return invalid()
  const campaigns = v.campaigns.map(campaign)
  const accounts = v.accounts.map(item => { const a = object(item); if (typeof a.connected !== 'boolean') return invalid(); return { provider: provider(a.provider), accountId: id(a.accountId), connected: a.connected } })
  if (new Set(campaigns.map(key)).size !== campaigns.length || new Set(accounts.map(accountKey)).size !== accounts.length) return invalid()
  const scopes = new Map(campaigns.map(c => [key(c), c]))
  if (campaigns.some(c => !accounts.some(a => accountKey(a) === accountKey(c)))) return invalid()
  const rows = v.rows.map((item): AdSpendRow => {
    const r = object(item), row = { ...identity(r), date: date(r.date) }, scope = scopes.get(key(row))
    if (!scope || !applies(scope, row.date) || !dashboardTimestamp(r.attemptedAt)
      || ![null, 'missing', 'fetch_failed', 'authentication_required'].includes(r.issue as null)
      || (r.observedAt !== null && (!dashboardTimestamp(r.observedAt) || r.observedAt > r.attemptedAt))
      || (r.amount === null) !== (r.observedAt === null) || (r.amount === null) !== (r.vat === null)
      || (r.amount === null && r.issue === null)) return invalid()
    return { ...row, amount: r.amount === null ? null : krwAmount(r.amount), vat: r.vat === null ? null : vat(r.vat),
      observedAt: r.observedAt as string | null, attemptedAt: r.attemptedAt, issue: r.issue as AdSpendRow['issue'],
      ...(r.provenance === undefined ? {} : { provenance: provenance(r.provenance, row.provider, r.observedAt as string | null) }) }
  })
  if (new Set(rows.map(rowKey)).size !== rows.length) return invalid()
  return { format: 1, campaigns, accounts, rows, lastDaangnImport: v.lastDaangnImport == null ? null : receipt(v.lastDaangnImport),
    ...(v.lastDaangnMcpImport == null ? {} : { lastDaangnMcpImport: receipt(v.lastDaangnMcpImport, true) }) }
}

// Internal normalized connector boundary, not an HTTP intake endpoint. No raw responses or credentials.
export function applyAdSpendAction(previous: AdSpendRecord, action: AdSpendAction, now = new Date()): AdSpendRecord {
  const record = parseAdSpendRecord(previous), stamp = now.toISOString()
  if (action.type === 'import_receipt') {
    record.lastDaangnImport = receipt(action.receipt)
  } else if (action.type === 'mcp_receipt') {
    record.lastDaangnMcpImport = receipt(action.receipt, true)
  } else if (action.type === 'configure') {
    const incoming = action.campaigns.map(campaign)
    if (!incoming.length || new Set(incoming.map(key)).size !== incoming.length) return invalid()
    for (const item of incoming) {
      const index = record.campaigns.findIndex(c => key(c) === key(item)), old = record.campaigns[index]
      if (old && (old.start !== item.start || record.rows.some(r => key(r) === key(item) && !applies(item, r.date)))) return invalid()
      if (index < 0) record.campaigns.push(item); else record.campaigns[index] = item
      if (!record.accounts.some(a => accountKey(a) === accountKey(item))) record.accounts.push({ provider: item.provider, accountId: item.accountId, connected: false })
    }
  } else if (action.type === 'connection') {
    const found = record.accounts.find(a => a.provider === provider(action.provider) && a.accountId === id(action.accountId))
    if (!found || typeof action.connected !== 'boolean') return invalid()
    found.connected = action.connected
  } else if (action.type === 'collect') {
    const source = provider(action.provider), accountId = id(action.accountId), start = date(action.start), end = date(action.end)
    if (end > dashboardKoreaDate(now)) return invalid()
    const dates = dashboardDates(start, end), scopes = record.campaigns.filter(c => c.provider === source && c.accountId === accountId)
    if (!scopes.length || !record.accounts.some(a => a.provider === source && a.accountId === accountId && a.connected)) return invalid()
    const expected = dates.flatMap(day => scopes.filter(c => applies(c, day)).map(c => ({ ...c, date: day })))
    if (!expected.length) return invalid()
    const expectedKeys = new Set(expected.map(rowKey)), seen = new Set<string>()
    const incoming = new Map<string, { amount: string; vat: VatBasis; provenance?: AdSpendProvenance }>()
    if (action.result.error !== undefined) {
      if (!['fetch_failed', 'authentication_required'].includes(action.result.error) || action.result.rows !== undefined) return invalid()
    } else {
      if (!Array.isArray(action.result.rows) || action.result.rows.length > expected.length) return invalid()
      for (const item of action.result.rows) {
        const k = rowKey({ provider: source, accountId, campaignId: id(item.campaignId), date: date(item.date) })
        if (!expectedKeys.has(k) || seen.has(k)) return invalid()
        seen.add(k); incoming.set(k, { amount: krwAmount(item.amount), vat: vat(item.vat),
          ...(item.provenance === undefined ? {} : { provenance: provenance(item.provenance, source, stamp) }) })
      }
    }
    const rows = new Map(record.rows.map(r => [rowKey(r), r]))
    for (const item of expected) {
      const k = rowKey(item), old = rows.get(k), fresh = incoming.get(k)
      if (old && old.attemptedAt > stamp) throw new Error('ad_spend_stale_attempt')
      const next: AdSpendRow = { provider: source, accountId, campaignId: item.campaignId, date: item.date,
        amount: fresh?.amount ?? old?.amount ?? null, vat: fresh?.vat ?? old?.vat ?? null,
        observedAt: fresh ? stamp : old?.observedAt ?? null, attemptedAt: stamp, issue: fresh ? null : action.result.error ?? 'missing',
        ...((fresh ? fresh.provenance : old?.provenance) ? { provenance: fresh ? fresh.provenance : old?.provenance } : {}) }
      // MCP does not state VAT. Only retain an existing verified basis for the exact same stored amount.
      const comparable = (value: string) => value.includes('.') ? value.replace(/0+$/, '').replace(/\.$/, '') : value
      if (fresh?.provenance?.kind === 'daangn_mcp' && fresh.vat === 'unknown' && old?.amount !== null && old?.amount !== undefined
        && old.vat && old.vat !== 'unknown' && comparable(old.amount) === comparable(fresh.amount)) {
        next.vat = old.vat
        next.provenance = { ...fresh.provenance, vatEvidence: old.provenance?.vatEvidence ?? { observedAt: old.observedAt!, hash: old.provenance?.hash ?? null } }
      }
      if (old?.attemptedAt === stamp && JSON.stringify(old) !== JSON.stringify(next)) throw new Error('ad_spend_conflicting_attempt')
      rows.set(k, next)
    }
    record.rows = [...rows.values()].sort((a, b) => rowKey(a).localeCompare(rowKey(b)))
  } else return invalid()
  return parseAdSpendRecord(record)
}

export function selectAdSpend(record: AdSpendRecord, start: string, end: string): AdSpendView {
  const dates = dashboardDates(dashboardDate(start), dashboardDate(end)), rows = new Map(record.rows.map(r => [rowKey(r), r]))
  const summarize = (days: string[], providers: readonly AdProvider[]): SpendSummary => {
    const scopes = record.campaigns.filter(c => providers.includes(c.provider))
    const units = days.flatMap(day => scopes.filter(c => applies(c, day)).map(c => rows.get(rowKey({ ...c, date: day }))))
    const observed = units.filter((r): r is AdSpendRow & { amount: string; vat: VatBasis; observedAt: string } => Boolean(r?.amount !== null && r?.amount !== undefined))
    const groups = (['included', 'excluded', 'unknown'] as const).flatMap(basis => {
      const values = observed.filter(r => r.vat === basis).map(r => r.amount)
      return values.length ? [{ vat: basis, amount: sumKrw(values) }] : []
    })
    const configured = providers.every(p => scopes.some(c => c.provider === p))
    const connected = scopes.length > 0 && scopes.every(c => record.accounts.some(a => accountKey(a) === accountKey(c) && a.connected))
    const status: SpendStatus = !configured ? (scopes.length ? 'scope_missing' : 'disconnected') : !connected ? 'disconnected'
      : !units.length ? 'out_of_scope' : units.some(r => r?.issue && r.issue !== 'missing') ? 'error'
      : units.some(r => !r || r.issue || r.amount === null) ? (observed.length ? 'partial' : 'missing')
      : groups.length !== 1 || groups[0].vat === 'unknown' ? 'tax_unconfirmed' : days.includes(dashboardKoreaDate()) ? 'provisional' : 'complete'
    const latest = (values: string[]) => values.sort().at(-1) ?? null
    return { total: ['complete', 'provisional'].includes(status) ? groups[0].amount : null, vat: ['complete', 'provisional'].includes(status) ? groups[0].vat : null,
      groups, status, expected: units.length, observed: observed.length, lastSuccessfulAt: latest(observed.map(r => r.observedAt)),
      lastAttemptAt: latest(units.flatMap(r => r ? [r.attemptedAt] : [])) }
  }
  const summary = (days: string[]) => ({ total: summarize(days, adProviders), providers: { naver: summarize(days, ['naver']), daangn: summarize(days, ['daangn']) } })
  const publicReceipt = (item: ImportReceipt | null | undefined) => item ? { at: item.at, start: item.start, end: item.end, rows: item.rows } : null
  return { start, end, availableFrom: AD_SPEND_START, currency: 'KRW', lastDaangnImport: publicReceipt(record.lastDaangnImport), lastDaangnMcpImport: publicReceipt(record.lastDaangnMcpImport), ...summary(dates), days: dates.map(day => ({ date: day, ...summary([day]) })) }
}
