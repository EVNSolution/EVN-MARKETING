import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, rm, link } from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { adProviders, applyAdSpendAction, emptyAdSpend, formatKrw, krwAmount, parseAdSpendRecord, selectAdSpend, sumKrw, type AdCampaign, type AdSpendAction, type AdProvider } from '@/lib/ad-spend'
import { readAdSpend, saveAdSpend } from '@/lib/ad-spend-store'
import { uploadResponse } from '@/lib/upload-security'
import { spawnSync } from 'node:child_process'

const first = new Date('2026-09-14T00:00:00.000Z'), later = new Date('2026-09-14T01:00:00.000Z')
const campaigns: AdCampaign[] = adProviders.map(provider => ({ provider, accountId: 'synthetic-account', campaignId: 'synthetic-evn', start: '2026-09-11', end: null, lifecycle: 'active' }))
const collect = (provider: AdProvider, amount = '0.10', vat: 'included' | 'excluded' | 'unknown' = 'included'): AdSpendAction => ({ type: 'collect', provider, accountId: 'synthetic-account', start: '2026-09-11', end: '2026-09-12', result: { rows: [
  { campaignId: 'synthetic-evn', date: '2026-09-11', amount, vat }, { campaignId: 'synthetic-evn', date: '2026-09-12', amount: '0.20', vat },
] } })
function configured() {
  let record = applyAdSpendAction(emptyAdSpend(), { type: 'configure', campaigns }, first)
  for (const provider of adProviders) record = applyAdSpendAction(record, { type: 'connection', provider, accountId: 'synthetic-account', connected: true }, first)
  return record
}
const view = (record = configured()) => selectAdSpend(record, '2026-09-11', '2026-09-12')
assert.equal(sumKrw(['0.10', '0.20']), '0.30')
assert.equal(sumKrw(['9007199254740993.123456789012', '0.000000000001']), '9007199254740993.123456789013')
assert.equal(formatKrw('9007199254740993.123456789012'), '9,007,199,254,740,993.123456789012원')
for (const amount of [0, -1, 'NaN', '1e3', '-1', '00.1', '1,000', '1.0000000000001', ' 1', '']) assert.throws(() => krwAmount(amount))
assert.equal(view(emptyAdSpend()).total.status, 'disconnected')
assert.equal(view().total.status, 'missing')
let record = applyAdSpendAction(configured(), collect('naver'), first)
assert.equal(view(record).total.total, null, 'one missing medium is not a complete total')
assert.equal(view(record).total.groups[0].amount, '0.30')
record = applyAdSpendAction(record, collect('daangn'), first)
assert.equal(view(record).total.total, '0.60')
assert.deepEqual(applyAdSpendAction(record, collect('naver'), first), record, 'identical retry is idempotent')
assert.throws(() => applyAdSpendAction(record, collect('naver', '1'), first), /conflicting_attempt/)
assert.throws(() => applyAdSpendAction(record, collect('naver'), new Date('2026-09-13T00:00:00.000Z')), /stale_attempt/)
record = applyAdSpendAction(record, collect('naver', '10.0001'), later)
assert.equal(view(record).total.total, '10.5001', 'correction replaces rather than adds')
assert.equal(record.rows.length, 4)
const mixed = applyAdSpendAction(record, collect('daangn', '0', 'excluded'), later)
assert.equal(view(mixed).total.total, null)
assert.equal(view(mixed).total.status, 'tax_unconfirmed')
assert.equal(view(mixed).providers.daangn.total, '0.20')
assert.equal(view(applyAdSpendAction(record, collect('daangn', '0', 'unknown'), later)).providers.daangn.total, null)
const failure: AdSpendAction = { type: 'collect', provider: 'naver', accountId: 'synthetic-account', start: '2026-09-11', end: '2026-09-12', result: { error: 'fetch_failed' } }
const failed = applyAdSpendAction(record, failure, new Date('2026-09-14T02:00:00.000Z'))
assert.equal(view(failed).total.status, 'error')
assert.equal(view(failed).total.total, null)
assert.equal(view(failed).providers.naver.groups[0].amount, '10.2001')
assert.equal(view(failed).providers.naver.lastSuccessfulAt, later.toISOString())
const partial = applyAdSpendAction(record, { ...failure, result: { rows: [] } }, new Date('2026-09-14T02:00:00.000Z'))
assert.equal(view(partial).providers.naver.status, 'partial')
assert.equal(view(partial).providers.naver.groups[0].amount, '10.2001', 'missing response rows never erase a successful amount')
assert.equal(view(applyAdSpendAction(record, { type: 'connection', provider: 'naver', accountId: 'synthetic-account', connected: false })).total.total, null)
const retired = applyAdSpendAction(record, { type: 'configure', campaigns: [{ ...campaigns[0], end: '2026-09-12', lifecycle: 'deleted' }] })
assert.equal(view(retired).total.total, '10.5001', 'retired campaign history remains included')
assert.equal(retired.campaigns.length, 2, 'configuration is additive; omission never deletes old scopes')
assert.throws(() => applyAdSpendAction(retired, { type: 'configure', campaigns: [{ ...campaigns[0], end: '2026-09-11' }] }))
assert.throws(() => applyAdSpendAction(record, { type: 'configure', campaigns: [{ ...campaigns[0], start: '2026-09-12' }] }))
const extraAccount = applyAdSpendAction(record, { type: 'configure', campaigns: [{ ...campaigns[0], accountId: 'synthetic-account-2' }] })
assert.equal(view(extraAccount).total.total, null, 'another explicitly allowed account must also be observed')
assert.equal(selectAdSpend(record, '2026-09-10', '2026-09-10').total.status, 'out_of_scope')
assert.throws(() => selectAdSpend(record, '2025-01-01', '2026-09-12'), /invalid_range/)
for (const bad of [
  { ...collect('naver'), accountId: 'foreign-account' },
  { ...collect('naver'), start: '2026-09-10' },
  { ...collect('naver'), end: '2026-09-15' },
  { ...collect('naver'), result: { rows: [{ date: '2026-09-11', campaignId: 'foreign-campaign', amount: '1', vat: 'included' }] } },
  { ...collect('naver'), result: { rows: [{ date: '2026-09-13', campaignId: 'synthetic-evn', amount: '1', vat: 'included' }] } },
  { ...collect('naver'), result: { rows: Array(2).fill({ date: '2026-09-11', campaignId: 'synthetic-evn', amount: '1', vat: 'included' }) } },
] as AdSpendAction[]) assert.throws(() => applyAdSpendAction(record, bad, later))
assert.throws(() => parseAdSpendRecord({ ...record, rows: [...record.rows, record.rows[0]] }))
assert.throws(() => parseAdSpendRecord({ ...record, campaigns: [] }))
assert.throws(() => parseAdSpendRecord({ ...record, rows: [{ ...record.rows[0], amount: 0.1 }] }))
assert.doesNotMatch(JSON.stringify(view(record)), /synthetic-account|synthetic-evn|campaignId|accountId/, 'public view contains no account/campaign identifiers')

async function main() {
  const root = await mkdtemp(path.join(tmpdir(), 'ad-spend-synthetic-')), env = { UPLOADS_DIR: root }
  try {
    assert.deepEqual(await readAdSpend(env), emptyAdSpend())
    await saveAdSpend({ type: 'configure', campaigns }, env, first)
    for (const provider of adProviders) await saveAdSpend({ type: 'connection', provider, accountId: 'synthetic-account', connected: true }, env, first)
    await saveAdSpend(collect('naver'), env, first)
    const file = path.join(root, '_reports/ad-spend/current.json'), before = await readFile(file, 'utf8')
    await assert.rejects(saveAdSpend({ ...collect('naver'), accountId: 'foreign' } as AdSpendAction, env, later))
    assert.equal(await readFile(file, 'utf8'), before, 'invalid scope never mutates durable data')
    await saveAdSpend(failure, env, later)
    assert.equal(view(await readAdSpend(env)).providers.naver.groups[0].amount, '0.30')
    await writeFile(path.join(root, '_reports/ad-spend/writer.lock'), '')
    await assert.rejects(saveAdSpend(collect('naver'), env, later), /writer_busy/)
    await rm(path.join(root, '_reports/ad-spend/writer.lock'))
    const concurrent = await Promise.allSettled([saveAdSpend(collect('naver'), env, new Date('2026-09-14T03:00:00.000Z')), saveAdSpend(collect('daangn'), env, new Date('2026-09-14T03:00:00.000Z'))])
    assert.ok(concurrent.some(r => r.status === 'fulfilled'))
    for (const result of concurrent) if (result.status === 'rejected') assert.match(String(result.reason), /writer_busy/)
    assert.ok((await readAdSpend(env)).rows.length >= 2)
    assert.equal((await uploadResponse(root, ['_reports', 'ad-spend', 'current.json'], true)).status, 404)
    await link(file, path.join(root, 'linked.json'))
    await assert.rejects(readAdSpend(env), /storage_error/)
    await assert.rejects(saveAdSpend(collect('naver'), env, later), /storage_error/)
    await rm(path.join(root, 'linked.json'))
    await writeFile(file, '{broken')
    await assert.rejects(readAdSpend(env), /storage_error/)
    await assert.rejects(saveAdSpend(collect('naver'), env, later), /storage_error/)
    assert.equal(await readFile(file, 'utf8'), '{broken', 'corruption is never silently overwritten')
    const cliRoot = path.join(root, 'cli')
    const cli = (input: unknown) => spawnSync(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'scripts/ad-spend.ts', '--stdin'], { env: { ...process.env, UPLOADS_DIR: cliRoot }, input: JSON.stringify(input), encoding: 'utf8', timeout: 20_000, windowsHide: true })
    const configured = cli({ action: { type: 'configure', campaigns: [{ ...campaigns[1], campaignId: '9007199254740993001' }] } })
    assert.equal(configured.status, 0, configured.stderr)
    assert.equal((await readAdSpend({ UPLOADS_DIR: cliRoot })).campaigns[0].campaignId, '9007199254740993001')
    const rejected = cli({ action: { type: 'invalid', detail: 'private-canary' } })
    assert.equal(rejected.status, 1)
    assert.doesNotMatch(rejected.stdout + rejected.stderr, /private-canary/)
  } finally { await rm(root, { recursive: true, force: true }) }
  console.log('Ad spend passed: exact KRW/VAT, allowlist/account/date scope, retries/corrections, missing vs zero, retired history, stale/failure preservation, atomic private storage and writer exclusion')
}
void main()
