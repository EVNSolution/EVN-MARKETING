import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, realpath, readFile, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { inquiryRealName } from '@/lib/format'
import { inquiryReview } from '@/lib/inquiry-review'
import { claimWorker, INQUIRY_SCOPE_ID } from '@/lib/inquiry-sync'
import { landingScope } from '@/lib/landing-inquiries'
import { scope } from '@/lib/warp-delivery'
import { dispatchNameJobs, requestNameJob, readNameJob } from '@/lib/warp-customer-name'
import { withWorkerDatabase } from './worker-runtime-helper'

const at = new Date('2026-10-15T05:00:00Z'), owner = 'name-review-worker'
const actor = { id: 'synthetic-admin', name: '합성 관리자' }
const key = 'synthetic-name-enrichment-key-not-real'
const token = 'synthetic-signed-preview'
type Db = Parameters<Parameters<typeof withWorkerDatabase>[0]>[0]
async function fixture(run: (db: Db, env: { UPLOADS_DIR: string; WARP_MARKETING_API_KEY: string }, selected: string, named: string) => Promise<void>, fromLanding = false) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'name-enrichment-')))
  try { await withWorkerDatabase(async db => {
    await claimWorker(db, owner, at)
    const base = { ...scope, inquiryDate: '2026-10-15', inquiryTime: '13:00', phone: '01011112222', lastSeenAt: at }
    const selected = await db.inquiry.create({ data: { ...base, sourceId: randomUUID(), name: '미상(📞 2222)', warpError: 'warp_duplicate_reviewed' } })
    const named = await db.inquiry.create({ data: { ...base, ...(fromLanding ? landingScope : scope), sourceId: randomUUID(), phone: '+82 10-1111-2222',
      name: '합성 김고객', warpDeliveredAt: at, warpCustomerId: 'retained-customer', warpActivityId: 'retained-activity' } })
    await run(db, { UPLOADS_DIR: root, WARP_MARKETING_API_KEY: key }, selected.id, named.id)
  }, ['20261007000100_landing_inquiries']) } finally { await rm(root, { recursive: true, force: true }) }
}
async function input(db: Db, id: string, candidateId: string) {
  const review = await inquiryReview(db, id); assert.ok(review)
  return { action: 'preview' as const, candidateId, reviewToken: review.reviewToken }
}
function provider(calls: Record<string, unknown>[]): typeof fetch {
  return async (url, init) => {
    assert.equal(String(url), 'https://warp.cleversystem.ai/api/external/marketing-inquiries/customer-name')
    assert.equal(new Headers(init?.headers).get('x-api-key'), key)
    assert.equal(init?.redirect, 'error')
    const body = JSON.parse(String(init?.body)); calls.push(body)
    assert.deepEqual(body.actor, actor)
    assert.equal(body.phone, '01011112222'); assert.equal(body.name, '합성 김고객')
    const confirming = body.action === 'confirm'
    if (confirming) assert.equal(body.previewToken, token)
    return Response.json({ ok: true, status: confirming ? 'updated' : 'ready', proposedName: body.name,
      customer: { id: 'warp-synthetic', name: confirming ? body.name : '미상(📞 2222)', phone: body.phone },
      ...(confirming ? { auditId: 'synthetic-name-audit' } : { previewToken: token }) })
  }
}
async function main() {
  for (const name of [null, '', '-', '미상', '신원미상', '미상(📞 2222)', '미상(서울 🚚 2222)', '010-1111-2222', '+82 10-1111-2222', '12345', '고객\n이름']) assert.equal(inquiryRealName(name, '01011112222'), null)
  assert.equal(inquiryRealName(' 합성 김고객 ', '01011112222'), '합성 김고객')
  assert.equal(inquiryRealName('미상상사', '01011112222'), '미상상사', 'do not reject real names merely containing 미상')

  for (const landing of [false, true]) await fixture(async (db, env, selected, named) => {
    const before = await db.inquiry.findMany({ orderBy: { id: 'asc' } })
    const review = await inquiryReview(db, selected); assert.ok(review)
    assert.deepEqual(review.nameCandidates.map(row => [row.id, row.name]), [[named, '합성 김고객']], 'historical delivered peer supplies the real name')
    const form = await input(db, selected, named), calls: Record<string, unknown>[] = [], send = provider(calls)
    const queued = await requestNameJob(db, selected, form, actor, { UPLOADS_DIR: env.UPLOADS_DIR }, at)
    assert.equal(queued.phase, 'preview', 'web queues without possessing the WARP key')
    assert.equal((await requestNameJob(db, selected, form, actor, env, at)).id, queued.id, 'double click does not queue twice')
    await assert.rejects(readNameJob(db, selected, queued.id, 'other-admin', env, at), /만료/)
    await assert.rejects(requestNameJob(db, selected, { ...form, action: 'confirm', jobId: queued.id }, actor, env, at), /먼저 확인/)
    await dispatchNameJobs(db, owner, undefined, send, env, () => at)
    const ready = await readNameJob(db, selected, queued.id, actor.id, env, at)
    assert.equal(ready.phase, 'ready'); assert.equal(ready.result?.customer?.name, '미상(📞 2222)')
    assert.ok(!JSON.stringify(ready).includes(token)); assert.ok(!JSON.stringify(ready).includes(key))
    const confirmed = await requestNameJob(db, selected, { ...form, action: 'confirm', jobId: queued.id }, actor, env, at)
    assert.equal(confirmed.phase, 'confirm'); assert.equal(calls.length, 1, 'explicit confirmation only enqueues; worker owns external writes')
    await dispatchNameJobs(db, owner, undefined, send, env, () => at)
    assert.equal((await readNameJob(db, selected, queued.id, actor.id, env, at)).result?.status, 'updated')
    await requestNameJob(db, selected, { ...form, action: 'confirm', jobId: queued.id }, actor, env, at)
    await dispatchNameJobs(db, owner, undefined, send, env, () => at)
    assert.equal(calls.length, 2, 'repeated confirm does not create another remote operation')
    assert.deepEqual(await db.inquiry.findMany({ orderBy: { id: 'asc' } }), before, 'source names, delivery evidence, counters and duplicate states remain intact')
    assert.equal((calls[0] as { source: string }).source, landing ? landingScope.source : scope.source)
    await assert.rejects(readNameJob(db, selected, queued.id, actor.id, env, new Date(at.getTime() + 21 * 60_000)), /만료/)
  }, landing)

  for (const mode of ['local-change', 'wrong-peer', 'missing-key', 'wrong-owner', 'invalid-response', 'lost-response', 'remote-stale'] as const) await fixture(async (db, env, selected, named) => {
    const form = await input(db, selected, named), calls: Record<string, unknown>[] = [], send = provider(calls)
    if (mode === 'wrong-peer') {
      await db.inquiry.update({ where: { id: named }, data: { phone: '01099998888' } })
      await assert.rejects(requestNameJob(db, selected, await input(db, selected, named), actor, env, at), /실명 문의/)
      return
    }
    const job = await requestNameJob(db, selected, form, actor, env, at)
    if (mode === 'wrong-owner') {
      await assert.rejects(dispatchNameJobs(db, 'other-worker', undefined, send, env, () => at), /lost_worker_lease/)
      assert.equal(calls.length, 0); return
    }
    if (mode === 'missing-key') {
      await dispatchNameJobs(db, owner, undefined, send, { UPLOADS_DIR: env.UPLOADS_DIR }, () => at)
      assert.equal((await readNameJob(db, selected, job.id, actor.id, env, at)).phase, 'failed'); assert.equal(calls.length, 0); return
    }
    await dispatchNameJobs(db, owner, undefined, send, env, () => at)
    await requestNameJob(db, selected, { ...form, action: 'confirm', jobId: job.id }, actor, env, at)
    if (mode === 'local-change') await db.inquiry.update({ where: { id: named }, data: { name: '바뀐 고객' } })
    const uncertain: typeof fetch = async (url, init) => {
      if (mode === 'remote-stale') return Response.json({ error: 'stale_preview' }, { status: 409 })
      if (mode === 'invalid-response') return Response.json({ ok: true, status: 'updated', proposedName: '합성 김고객', customer: { id: 'wrong', name: '합성 김고객', phone: '01099998888' }, auditId: 'x' })
      if (mode === 'lost-response') { calls.push(JSON.parse(String(init?.body))); throw new Error('synthetic network loss') }
      return send(url, init)
    }
    await dispatchNameJobs(db, owner, undefined, uncertain, env, () => at)
    const view = await readNameJob(db, selected, job.id, actor.id, env, at)
    assert.equal(view.phase, ['local-change', 'remote-stale'].includes(mode) ? 'failed' : 'confirm')
    if (mode === 'local-change') assert.equal(calls.length, 1, 'changed inquiry cancels queued external write')
    if (mode === 'lost-response') {
      await dispatchNameJobs(db, owner, undefined, send, env, () => at)
      assert.deepEqual(calls[1], calls[2], 'uncertain confirmation retries the exact signed operation')
      assert.equal((await readNameJob(db, selected, job.id, actor.id, env, at)).phase, 'done')
    }
    if (mode === 'invalid-response') {
      await dispatchNameJobs(db, owner, undefined, uncertain, env, () => at)
      await dispatchNameJobs(db, owner, undefined, uncertain, env, () => at)
      assert.equal((await readNameJob(db, selected, job.id, actor.id, env, at)).phase, 'failed')
    }
  })

  await fixture(async (db, env, selected, named) => {
    await db.inquirySyncState.update({ where: { id: INQUIRY_SCOPE_ID }, data: { workerLeaseExpiresAt: at } })
    await assert.rejects(requestNameJob(db, selected, await input(db, selected, named), actor, env, at), /수집 연결/)
  })
  await fixture(async (db, env, selected, named) => {
    const form = await input(db, selected, named)
    await requestNameJob(db, selected, form, actor, env, at)
    const file = path.join(env.UPLOADS_DIR, '_reports/warp-customer-name/pending.json')
    assert.ok(!(await readFile(file, 'utf8')).includes(key), 'WARP credential is never persisted')
    await rm(file); await symlink(path.join(env.UPLOADS_DIR, 'nonexistent'), file)
    await assert.rejects(requestNameJob(db, selected, form, actor, env, at), /storage_unavailable/)
  })
  console.log('Customer name review passed: delivered peer candidates, both scopes, worker-only key, explicit confirmation, actor isolation, stale/lease guards, idempotent retry, malformed response, private storage, unchanged inquiries and receipts')
}
main().catch(error => { console.error(error); process.exitCode = 1 })
