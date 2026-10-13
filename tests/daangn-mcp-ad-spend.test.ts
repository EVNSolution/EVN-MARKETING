import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { DAANGN_MCP_MAX, importDaangnMcp, previewDaangnMcp, readDaangnMcpBody } from '@/lib/daangn-mcp-ad-spend'
import { readAdSpend, saveAdSpendActions } from '@/lib/ad-spend-store'
import { parseAdSpendRecord, selectAdSpend } from '@/lib/ad-spend'
import { daangnCampaign, naverCampaigns } from '@/lib/ad-spend-config'

const now = new Date('2026-10-13T03:00:00.000Z'), fetchedAt = '2026-10-13T00:00:00.000Z'
const report = (date = '2026-10-12', amount = '1234') => ({
  request: { advertiser_id: '4541556', advertiser_request: '합성 일별 광고비 검증', start_date: date, end_date: date, metrics: ['COST'], structure: [{ type: 'campaign', filter: ['1786077964797444000'], grouping: true }], page: 1, page_size: 1 },
  response: { totals: { COST: amount }, rows: [{ analysis_items: { CAMPAIGN: { id: '1786077964797444000', name: '합성 EVN 캠페인' } }, metrics: { COST: amount } }], has_more: false, applied: { start_date: date, end_date: date, duration: 'ALL', page: 1, page_size: 1, sort: null } },
})
const input = () => ({ version: 1, source: 'daangn_mcp', fetchedAt, reports: [report()] })
const bytes = (value: unknown) => Buffer.from(JSON.stringify(value))
const preview = (value: unknown) => previewDaangnMcp(bytes(value), now)
assert.equal(preview(input()).amount, '1234')
const precise = input(); precise.reports = [report('2026-10-12', '90071992547409931234567890')]
assert.equal(preview(precise).amount, '90071992547409931234567890')
const zero = input(); zero.reports = [report('2026-10-12', '0')]
assert.equal(preview(zero).rows[0].amount, '0')
const empty = input(); empty.reports = [report('2026-10-12', '0')]; empty.reports[0].response.rows = []
assert.equal(preview(empty).amount, null); assert.deepEqual(preview(empty).missingDays, ['2026-10-12'])
const duplicate = input(); duplicate.reports.push(report()); assert.throws(() => preview(duplicate))
for (const mutate of [
  (v: ReturnType<typeof input>) => { v.source = 'daangn_csv' },
  (v: ReturnType<typeof input>) => { v.fetchedAt = '2026-10-14T00:00:00.000Z' },
  (v: ReturnType<typeof input>) => { v.reports[0].request.advertiser_id = '4541557' },
  (v: ReturnType<typeof input>) => { v.reports[0].request.structure[0].filter = ['1786077964797444001'] },
  (v: ReturnType<typeof input>) => { v.reports[0].request.structure[0].grouping = false },
  (v: ReturnType<typeof input>) => { v.reports[0].request.end_date = '2026-10-13' },
  (v: ReturnType<typeof input>) => { v.reports[0].request.metrics = ['COST', 'CLICKS'] },
  (v: ReturnType<typeof input>) => { v.reports[0].request.page = 2 },
  (v: ReturnType<typeof input>) => { v.reports[0].response.has_more = true },
  (v: ReturnType<typeof input>) => { v.reports[0].response.applied.duration = 'DAY' },
  (v: ReturnType<typeof input>) => { v.reports[0].response.applied.start_date = '2026-10-11' },
  (v: ReturnType<typeof input>) => { v.reports[0].response.totals.COST = '1235' },
  (v: ReturnType<typeof input>) => { v.reports[0].response.rows[0].analysis_items.CAMPAIGN.id = '1786077964797444001' },
  (v: ReturnType<typeof input>) => { v.reports[0].response.rows.push(v.reports[0].response.rows[0]) },
  (v: ReturnType<typeof input>) => { v.reports = [report('2026-10-13')] },
  (v: ReturnType<typeof input>) => { v.reports = [report('2026-09-10')] },
  (v: ReturnType<typeof input>) => { v.reports = [report('2026-09-11'), report('2026-10-12')] },
  (v: ReturnType<typeof input>) => { v.reports = Array.from({ length: 32 }, () => report()) },
]) { const value = input(); mutate(value); assert.throws(() => preview(value)) }
for (const amount of ['1.0', '01', '-1', '1e3', '1,234', '1234567890123456789012345678901']) {
  const value = input(); value.reports = [report('2026-10-12', amount)]; assert.throws(() => preview(value))
}
assert.throws(() => preview(JSON.parse(JSON.stringify(input()).replace('"1234"', '1234'))), 'numeric money is rejected')
assert.throws(() => preview(JSON.parse(JSON.stringify(input()).replaceAll('"1786077964797444000"', '1786077964797444000'))), 'numeric campaign IDs are rejected')
assert.throws(() => preview({ ...input(), apiKey: 'must-not-be-accepted' }))
assert.throws(() => previewDaangnMcp(new Uint8Array([0xff]), now))
assert.throws(() => previewDaangnMcp(new Uint8Array(DAANGN_MCP_MAX + 1), now))
assert.throws(() => previewDaangnMcp(bytes(input()), new Date('2027-12-13T00:00:00.000Z')), 'older than 13 months')

async function main() {
  const root = await mkdtemp(path.join(tmpdir(), 'daangn-mcp-synthetic-')), env = { UPLOADS_DIR: root }
  const file = path.join(root, '_reports/ad-spend/current.json')
  try {
    await saveAdSpendActions([
      { type: 'configure', campaigns: [daangnCampaign, naverCampaigns[0]] },
      { type: 'connection', provider: 'daangn', accountId: daangnCampaign.accountId, connected: true },
      { type: 'connection', provider: 'naver', accountId: naverCampaigns[0].accountId, connected: true },
      { type: 'collect', provider: 'naver', accountId: naverCampaigns[0].accountId, start: '2026-10-12', end: '2026-10-12', result: { rows: [{ date: '2026-10-12', campaignId: naverCampaigns[0].campaignId, amount: '777', vat: 'included' }] } },
      { type: 'collect', provider: 'daangn', accountId: daangnCampaign.accountId, start: '2026-10-10', end: '2026-10-12', result: { rows: ['2026-10-10', '2026-10-11', '2026-10-12'].map(date => ({ date, campaignId: daangnCampaign.campaignId, amount: '1234.00', vat: 'included' as const })) } },
    ], env, new Date('2026-10-12T23:00:00.000Z'))
    const previous = await readAdSpend(env), data = input(), snapshot = await readFile(file, 'utf8')
    preview(data); assert.equal(await readFile(file, 'utf8'), snapshot, 'preview does not write')
    await importDaangnMcp(bytes(data), preview(data).hash, env, now)
    const saved = await readAdSpend(env), day = saved.rows.find(r => r.provider === 'daangn' && r.date === '2026-10-12')!
    assert.equal(day.amount, '1234'); assert.equal(day.vat, 'included', 'matching CSV-scale value retains verified VAT')
    assert.equal(day.provenance?.kind, 'daangn_mcp'); assert.ok(day.provenance?.vatEvidence)
    assert.deepEqual(saved.rows.filter(r => r.provider === 'naver' || r.date !== '2026-10-12'), previous.rows.filter(r => r.provider === 'naver' || r.date !== '2026-10-12'))
    await importDaangnMcp(bytes(data), preview(data).hash, env, now)
    assert.deepEqual(await readAdSpend(env), saved, 'identical acquisition replay is idempotent')
    const changed = input(); changed.fetchedAt = '2026-10-13T01:00:00.000Z'; changed.reports = [report('2026-10-12', '2345')]
    await importDaangnMcp(bytes(changed), preview(changed).hash, env, now)
    const updated = await readAdSpend(env)
    assert.equal(updated.rows.find(r => r.provider === 'daangn' && r.date === '2026-10-12')!.vat, 'unknown', 'changed amount cannot inherit VAT')
    assert.equal(selectAdSpend(updated, '2026-10-12', '2026-10-12').total.total, null)
    const newerEmpty = { ...empty, fetchedAt: '2026-10-13T02:00:00.000Z' }
    await importDaangnMcp(bytes(newerEmpty), preview(newerEmpty).hash, env, now)
    const missing = (await readAdSpend(env)).rows.find(r => r.provider === 'daangn' && r.date === '2026-10-12')!
    assert.equal(missing.amount, '2345'); assert.equal(missing.issue, 'missing'); assert.equal(missing.provenance?.hash, preview(changed).hash)
    const beforeFailure = await readFile(file, 'utf8')
    await assert.rejects(importDaangnMcp(bytes(data), preview(data).hash, env, now), /stale_attempt/)
    await assert.rejects(importDaangnMcp(bytes(changed), '0'.repeat(64), env, now), /changed/)
    const invalidBatch = input(); invalidBatch.reports.push(report('2026-10-13'))
    await assert.rejects(importDaangnMcp(bytes(invalidBatch), '0'.repeat(64), env, now))
    assert.equal(await readFile(file, 'utf8'), beforeFailure, 'rejected imports leave complete store unchanged')
    assert.deepEqual(parseAdSpendRecord(JSON.parse(beforeFailure)), await readAdSpend(env), 'provenance survives store read')
    const read = await readDaangnMcpBody(new Request('http://localhost', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: bytes(input()) }))
    assert.equal(previewDaangnMcp(read, now).amount, '1234')
    await assert.rejects(readDaangnMcpBody(new Request('http://localhost', { method: 'POST', headers: { 'Content-Type': 'text/csv' }, body: '{}' })))
    await assert.rejects(readDaangnMcpBody(new Request('http://localhost', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: 'x'.repeat(DAANGN_MCP_MAX + 1) })))
  } finally { await rm(root, { recursive: true, force: true }) }
  console.log('Daangn MCP passed: strict original transcript, scope/date/paging/total/integer/batch limits, unknown/matching VAT, provenance, missing != zero, replay, stale rejection, Naver/history preservation and atomic import')
}
void main()
