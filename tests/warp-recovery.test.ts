import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import type { PrismaClient } from '@/app/generated/prisma/client'
import { claimWorker, ensureSyncState, INQUIRY_SCOPE_ID, releaseWorker, WORKER_LEASE_MS } from '@/lib/inquiry-sync'
import { MANUAL_CONFIRMATION, scope, WARP_RECEIPT_UNVERIFIED, warpActivityId } from '@/lib/warp-delivery'
import { applyWarpRecovery, MAX_RECOVERY_ROWS, parseRecoveryPlan, planWarpRecovery, recoverySha256, type RecoveryEvent } from '@/lib/warp-recovery'
import { withWorkerDatabase } from './worker-runtime-helper'

const env = { WARP_MARKETING_API_KEY: 'synthetic-recovery-key-never-used-in-production', WARP_DELIVERY_ENABLED: 'false' }
const at = new Date('2026-09-23T00:00:00Z')
const now = () => at
const sourceId = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const customerId = 'synthetic-existing-customer'
const name = 'synthetic-private-name'
const phone = '010-0000-1234'
const privateError = `${name} ${phone} ${env.WARP_MARKETING_API_KEY}`
const root = process.cwd()
globalThis.fetch = async () => { throw new Error('real network access is forbidden') }

async function add(db: PrismaClient, n: number, delivered = false, overrides = {}) {
  return db.inquiry.create({ data: {
    ...scope, sourceId: sourceId(n), inquiryDate: '2026-09-22', inquiryTime: '09:00',
    name, phone, sourceStatus: 'received', lastSeenAt: at,
    ...(delivered ? { warpCustomerId: customerId, warpActivityId: warpActivityId(sourceId(n)), warpDeliveredAt: at, warpAttemptedAt: at } : {}),
    ...overrides,
  } })
}

async function planFor(db: PrismaClient, ids: string[]) {
  const plan = await planWarpRecovery(db, ids, at)
  const bytes = `${JSON.stringify(plan, null, 2)}\n`
  return { plan, bytes, hash: recoverySha256(bytes) }
}

function receiver() {
  const activities = new Map<string, string>()
  // A synthetic receiver models the reviewed append-only, primary-phone match contract.
  const customer = { id: customerId, name: 'authored CRM name', phone, memo: 'authored memo', assignee: 'existing owner' }
  const calls: string[] = []
  const send: typeof fetch = async (url, init) => {
    assert.equal(url, 'https://warp.cleversystem.ai/api/external/marketing-inquiries')
    assert.equal(init?.method, 'POST')
    assert.equal(init.redirect, 'error')
    assert.equal(new Headers(init.headers).get('x-api-key'), env.WARP_MARKETING_API_KEY)
    assert.equal(init.signal?.aborted, false)
    const payload = JSON.parse(String(init.body))
    assert.deepEqual(Object.keys(payload).sort(), ['source', 'companyScopeId', 'homepageScopeId', 'sourceId', 'inquiryDate', 'inquiryTime', 'sourceStatus', 'name', 'phone', 'rejectExistingCustomer'].sort())
    assert.equal(payload.rejectExistingCustomer, true)
    assert.equal(payload.phone, customer.phone)
    assert.equal(payload.companyScopeId, scope.companyScopeId)
    calls.push(payload.sourceId)
    const activityId = warpActivityId(payload.sourceId)
    const duplicate = activities.has(activityId)
    activities.set(activityId, customer.id)
    return Response.json({ ok: true, customerId: customer.id, activityId, created: !duplicate, duplicate })
  }
  return { activities, customer, calls, send }
}

function auditLog() {
  const events: RecoveryEvent[] = []
  return { events, audit: async (event: RecoveryEvent) => { events.push(structuredClone(event)) } }
}

function noPrivateValues(value: string) {
  for (const secret of [name, phone, env.WARP_MARKETING_API_KEY]) assert.equal(value.includes(secret), false)
}

async function testAsymmetricRecovery() {
  await withWorkerDatabase(async db => {
    const originalId = 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA'
    const olderMarketing = await add(db, 1, false, { sourceId: originalId })
    const olderWarp = await add(db, 2, true)
    const unselected = await add(db, 3)
    const unselectedDelivered = await add(db, 4, true)
    const otherScope = await add(db, 1, false, { companyScopeId: 'other-scope' })
    await db.customer.create({ data: { id: customerId, name: 'local authored name', phone, memo: 'keep memo', assignee: 'keep owner' } })
    const originalCustomers = await db.customer.findMany()
    const originalActivities = await db.customerActivity.findMany()
    await ensureSyncState(db)
    await db.inquirySyncState.update({ where: { id: INQUIRY_SCOPE_ID }, data: { nextRunAt: at, lastSuccessfulAt: at } })
    const originalState = await db.inquirySyncState.findMany()
    const originalRows = await db.inquiry.findMany()
    const remote = receiver()
    const originalRemoteCustomer = structuredClone(remote.customer)
    remote.activities.set(warpActivityId(originalId), customerId)
    const { plan, bytes, hash } = await planFor(db, [originalId, sourceId(2)])
    assert.equal(plan.comparison, 'local-only')
    assert.equal(plan.rows[0].sourceId, originalId, 'manifest preserves exact original UUID spelling')
    assert.deepEqual(await db.inquiry.findMany(), originalRows, 'dry-run is read only')
    assert.deepEqual(await db.inquirySyncState.findMany(), originalState, 'dry-run does not claim a lease')
    assert.equal(remote.calls.length, 0)
    noPrivateValues(bytes)
    const log = auditLog()
    const result = await applyWarpRecovery(db, bytes, hash, { ...log, send: remote.send, env, now })
    assert.deepEqual(result, { status: 'ok', selected: 2, attempted: 2, confirmed: 2, created: 1, duplicate: 1 })
    const restored = await db.inquiry.findUniqueOrThrow({ where: { id: olderMarketing.id } })
    assert.equal(restored.sourceId, originalId)
    assert.equal(restored.warpCustomerId, customerId)
    assert.equal(restored.warpActivityId, warpActivityId(originalId))
    assert.ok(restored.warpDeliveredAt)
    assert.equal(restored.warpError, WARP_RECEIPT_UNVERIFIED, 'replay alone is retained as confirmation-needed evidence')
    assert.deepEqual(await db.inquiry.findUniqueOrThrow({ where: { id: olderWarp.id } }), olderWarp, 'already-delivered receipt remains original historical evidence')
    for (const row of [unselected, unselectedDelivered, otherScope]) assert.deepEqual(await db.inquiry.findUniqueOrThrow({ where: { id: row.id } }), row)
    assert.deepEqual(await db.customer.findMany(), originalCustomers)
    assert.deepEqual(await db.customerActivity.findMany(), originalActivities)
    assert.deepEqual(remote.customer, originalRemoteCustomer)
    assert.deepEqual(remote.calls, [originalId.toLowerCase(), sourceId(2)])
    assert.equal(remote.activities.size, 2)
    noPrivateValues(JSON.stringify(log.events))
    const state = await db.inquirySyncState.findUniqueOrThrow({ where: { id: INQUIRY_SCOPE_ID } })
    assert.equal(state.workerOwner, null)
    assert.equal(state.workerLeaseExpiresAt, null)
    assert.deepEqual(state.nextRunAt, at)
    assert.deepEqual(state.lastSuccessfulAt, at)
    assert.equal(env.WARP_DELIVERY_ENABLED, 'false')

    const fresh = await planFor(db, [originalId, sourceId(2)])
    const again = await applyWarpRecovery(db, fresh.bytes, fresh.hash, { ...log, send: remote.send, env, now })
    assert.equal(again.duplicate, 2)
    assert.equal(remote.activities.size, 2, 'same activity IDs never create duplicate activities')
  })
}

async function testApprovalAndDrift() {
  await withWorkerDatabase(async db => {
    const first = await add(db, 1)
    const second = await add(db, 2, true)
    await add(db, 3, false, { companyScopeId: 'other-scope' })
    for (const ids of [[], Array.from({ length: 21 }, (_, i) => sourceId(i)), [sourceId(1), sourceId(1)], [privateError]]) {
      await assert.rejects(planWarpRecovery(db, ids), /warp_recovery_invalid_selection/)
    }
    await assert.rejects(planWarpRecovery(db, [sourceId(3)]), /warp_recovery_selection_missing/)
    const { plan, bytes, hash } = await planFor(db, [sourceId(1), sourceId(2)])
    assert.equal('keyBinding' in plan, false, 'local-only plans do not read or bind credentials')
    assert.deepEqual(parseRecoveryPlan(bytes, hash), plan)
    const remote = receiver()
    const log = auditLog()
    const apply = (text = bytes, digest = recoverySha256(text), overrides = {}) => applyWarpRecovery(db, text, digest, { ...log, send: remote.send, env, now, ...overrides })
    assert.equal((await apply(bytes, '0'.repeat(64))).status, 'warp_recovery_approval_mismatch')
    assert.equal((await apply(bytes + ' ', hash)).status, 'warp_recovery_approval_mismatch')
    assert.equal((await apply(bytes, hash, { env: {} })).status, 'warp_key_required')
    assert.equal((await apply(bytes, hash, { env: { WARP_MARKETING_API_KEY: ` ${'x'.repeat(32)}` } })).status, 'warp_key_required')
    assert.equal(await db.inquirySyncState.count(), 0, 'invalid approvals and keys never acquire a lease')
    for (const mutation of [
      { ...plan, scope: { ...scope, companyScopeId: 'other-scope' } },
      { ...plan, version: 2 },
      { ...plan, unexpected: privateError },
      { ...plan, rows: [{ ...plan.rows[0], sourceId: sourceId(2) }] },
      { ...plan, rows: [{ ...plan.rows[0], payloadSha256: 'a'.repeat(64) }, plan.rows[1]] },
      { ...plan, rows: [plan.rows[0], plan.rows[0]] },
      { ...plan, rows: Array.from({ length: 21 }, (_, i) => ({ ...plan.rows[0], sourceId: sourceId(i) })) },
    ]) assert.notEqual((await apply(JSON.stringify(mutation))).status, 'ok')
    assert.notEqual((await apply(`{"secret":"${privateError}"`)).status, 'ok')
    assert.equal(remote.calls.length, 0)

    const manualPlan = await planFor(db, [sourceId(1)])
    await db.inquiry.update({ where: { id: first.id }, data: { warpError: MANUAL_CONFIRMATION } })
    assert.equal((await applyWarpRecovery(db, manualPlan.bytes, manualPlan.hash, { ...log, send: remote.send, env, now })).status, 'warp_recovery_manual_confirmation')
    assert.equal(remote.calls.length, 0, 'manual confirmation is rejected before recovery sends')
    await db.inquiry.update({ where: { id: first.id }, data: first })

    // Drift in the LAST selected row blocks the entire plan before the FIRST request.
    for (const changes of [{ phone: '010-0000-5678' }, { warpAttemptedAt: new Date(at.getTime() + 1) }, { warpCustomerId: 'changed' }, { homepageScopeId: 'other-homepage' }]) {
      await db.inquiry.update({ where: { id: second.id }, data: changes })
      assert.equal((await apply()).status, 'warp_recovery_row_changed')
      assert.equal(remote.calls.length, 0)
      await db.inquiry.update({ where: { id: second.id }, data: second })
    }
    assert.deepEqual(await db.inquiry.findUniqueOrThrow({ where: { id: first.id } }), first)
    assert.equal(await claimWorker(db, 'other-worker', at), true)
    assert.equal((await apply()).status, 'worker_already_running')
    assert.equal((await db.inquirySyncState.findUniqueOrThrow({ where: { id: INQUIRY_SCOPE_ID } })).workerOwner, 'other-worker')
    await releaseWorker(db, 'other-worker', at)
    assert.equal(remote.calls.length, 0)
    noPrivateValues(JSON.stringify(log.events))
  })
}

async function testFailureAndRetry() {
  await withWorkerDatabase(async db => {
    const first = await add(db, 1)
    const second = await add(db, 2, true)
    const remote = receiver()
    const log = auditLog()
    const { bytes, hash } = await planFor(db, [sourceId(1), sourceId(2)])
    const lost: typeof fetch = async (url, init) => { await remote.send(url, init); throw new Error(privateError) }
    const failed = await applyWarpRecovery(db, bytes, hash, { ...log, send: lost, env, now })
    assert.deepEqual(failed, { status: 'warp_unavailable', selected: 2, attempted: 1, confirmed: 0, created: 0, duplicate: 0 })
    assert.deepEqual(await db.inquiry.findUniqueOrThrow({ where: { id: first.id } }), first)
    assert.deepEqual(await db.inquiry.findUniqueOrThrow({ where: { id: second.id } }), second)
    assert.equal(remote.activities.size, 1)
    const recovered = await applyWarpRecovery(db, bytes, hash, { ...log, send: remote.send, env, now })
    assert.equal(recovered.status, 'ok')
    assert.equal(recovered.duplicate, 1)
    assert.equal(remote.activities.size, 2, 'retry after remote commit and response loss reuses the original source ID')

    const deliveredPlan = await planFor(db, [sourceId(2)])
    const lostDelivered = await applyWarpRecovery(db, deliveredPlan.bytes, deliveredPlan.hash, { ...log, send: lost, env, now })
    assert.equal(lostDelivered.status, 'warp_unavailable')
    assert.deepEqual(await db.inquiry.findUniqueOrThrow({ where: { id: second.id } }), second)
    assert.equal((await applyWarpRecovery(db, deliveredPlan.bytes, deliveredPlan.hash, { ...log, send: remote.send, env, now })).duplicate, 1)
    noPrivateValues(JSON.stringify(log.events))
  })

  for (const [status, response, expected] of [
    [401, { error: privateError }, 'warp_auth_required'],
    [409, { error: 'ambiguous_phone', privateError }, 'warp_customer_conflict'],
    [503, { error: 'temporarily_unavailable', privateError }, 'warp_unavailable'],
    [200, { ok: true, customerId, activityId: warpActivityId(sourceId(1)), created: true, duplicate: true }, 'warp_invalid_receipt'],
    [200, { ok: true, customerId, activityId: warpActivityId(sourceId(2)), created: true, duplicate: false }, 'warp_invalid_receipt'],
    [200, { ok: true, customerId: 'wrong-customer', activityId: warpActivityId(sourceId(1)), created: true, duplicate: false }, 'warp_recovery_customer_mismatch'],
  ] as const) {
    await withWorkerDatabase(async db => {
      const first = await add(db, 1, true)
      const second = await add(db, 2)
      const { bytes, hash } = await planFor(db, [sourceId(1), sourceId(2)])
      let calls = 0
      const result = await applyWarpRecovery(db, bytes, hash, { env, now, ...auditLog(), send: async () => {
        calls++
        return Response.json(response, { status })
      } })
      assert.equal(result.status, expected)
      assert.equal(calls, 1, 'first failure stops the bounded batch without retrying')
      assert.deepEqual(await db.inquiry.findUniqueOrThrow({ where: { id: first.id } }), first)
      assert.deepEqual(await db.inquiry.findUniqueOrThrow({ where: { id: second.id } }), second)
      noPrivateValues(JSON.stringify(result))
    })
  }
}

async function testStopLeaseAndMidRunDrift() {
  for (const scenario of ['already-stopped', 'stop-before-send', 'stop-during-send', 'lease-before-send', 'lease-after-send', 'expired-after-send', 'row-before-send', 'row-after-send', 'audit-fails'] as const) {
    await withWorkerDatabase(async db => {
      const first = await add(db, 1, true)
      const second = await add(db, 2)
      const original = await db.inquiry.findMany()
      const { bytes, hash } = await planFor(db, [sourceId(1), sourceId(2)])
      const remote = receiver()
      const stop = new AbortController()
      let time = at
      let requests = 0
      if (scenario === 'already-stopped') stop.abort()
      const result = await applyWarpRecovery(db, bytes, hash, {
        env, now: () => time, signal: stop.signal,
        audit: async event => {
          if (event.event !== 'attempt') return
          if (scenario === 'stop-before-send') stop.abort()
          if (scenario === 'lease-before-send') await db.inquirySyncState.update({ where: { id: INQUIRY_SCOPE_ID }, data: { workerOwner: 'replacement' } })
          if (scenario === 'row-before-send') await db.inquiry.update({ where: { id: first.id }, data: { sourceStatus: 'changed' } })
          if (scenario === 'audit-fails') throw new Error(privateError)
        },
        send: async (url, init) => {
          requests++
          if (scenario === 'stop-during-send') {
            assert.ok(init?.signal)
            const aborted = new Promise<never>((_, reject) => init.signal!.addEventListener('abort', () => reject(new Error(privateError)), { once: true }))
            stop.abort()
            return aborted
          }
          const response = await remote.send(url, init)
          if (scenario === 'lease-after-send') await db.inquirySyncState.update({ where: { id: INQUIRY_SCOPE_ID }, data: { workerOwner: 'replacement' } })
          if (scenario === 'expired-after-send') time = new Date(at.getTime() + WORKER_LEASE_MS + 1)
          if (scenario === 'row-after-send') await db.inquiry.update({ where: { id: first.id }, data: { sourceStatus: 'changed' } })
          return response
        },
      })
      const expected = scenario.includes('stop') ? 'warp_recovery_interrupted'
        : scenario.includes('lease') || scenario.includes('expired') ? 'lost_worker_lease'
          : scenario.includes('row') ? 'warp_recovery_row_changed' : 'warp_recovery_failed'
      assert.equal(result.status, expected, scenario)
      assert.equal(result.confirmed, 0)
      assert.equal(requests, scenario.endsWith('after-send') || scenario === 'stop-during-send' ? 1 : 0)
      const current = await db.inquiry.findUniqueOrThrow({ where: { id: first.id } })
      assert.equal(current.warpCustomerId, first.warpCustomerId)
      assert.deepEqual(current.warpDeliveredAt, first.warpDeliveredAt)
      assert.deepEqual(await db.inquiry.findUniqueOrThrow({ where: { id: second.id } }), second)
      if (!scenario.startsWith('row')) assert.deepEqual(await db.inquiry.findMany(), original)
      const state = await db.inquirySyncState.findUnique({ where: { id: INQUIRY_SCOPE_ID } })
      assert.equal(state?.workerOwner ?? null, scenario.startsWith('lease') ? 'replacement' : null)
    })
  }

  await withWorkerDatabase(async db => {
    await add(db, 1)
    const second = await add(db, 2)
    const { bytes, hash } = await planFor(db, [sourceId(1), sourceId(2)])
    const remote = receiver()
    const stop = new AbortController()
    const result = await applyWarpRecovery(db, bytes, hash, { env, now, signal: stop.signal, send: remote.send, audit: async event => {
      if (event.event === 'attempt' && event.row.sourceId === sourceId(2)) stop.abort()
    } })
    assert.equal(result.status, 'warp_recovery_interrupted')
    assert.equal(result.confirmed, 1)
    assert.equal(remote.calls.length, 1)
    assert.deepEqual(await db.inquiry.findUniqueOrThrow({ where: { id: second.id } }), second)
    const retry = await applyWarpRecovery(db, bytes, hash, { env, now, send: remote.send, ...auditLog() })
    assert.equal(retry.status, 'warp_recovery_row_changed', 'partially acknowledged plans require a fresh local plan and approval')
    assert.equal(remote.calls.length, 1)
  })
}

async function testBound() {
  await withWorkerDatabase(async db => {
    for (let n = 1; n <= MAX_RECOVERY_ROWS + 1; n++) await add(db, n)
    const { bytes, hash } = await planFor(db, Array.from({ length: MAX_RECOVERY_ROWS }, (_, i) => sourceId(i + 1)))
    const remote = receiver()
    const result = await applyWarpRecovery(db, bytes, hash, { env, now, send: remote.send, ...auditLog() })
    assert.equal(result.confirmed, 20)
    assert.equal(remote.calls.length, 20)
    assert.equal((await db.inquiry.findFirstOrThrow({ where: { sourceId: sourceId(21) } })).warpDeliveredAt, null)
  })
}

async function testCli() {
  const temp = await mkdtemp(path.join(root, '.warp-recovery-test-'))
  const require = createRequire(import.meta.url)
  try {
    const source = path.join(root, 'scripts/warp-recovery.ts')
    const bundle = path.join(temp, 'warp-recovery.mjs')
    await build({ entryPoints: [source], bundle: true, platform: 'node', format: 'esm', packages: 'external', outfile: bundle })
    const startup = `process.umask(Number(process.env.SYNTHETIC_UMASK ?? 0)); globalThis.fetch = async (url, init) => {
      if (process.argv[2] === 'plan') throw Error('dry-run must never send');
      if (url !== 'https://warp.cleversystem.ai/api/external/marketing-inquiries' || init.method !== 'POST') throw Error('unexpected network');
      const p = JSON.parse(init.body);
      const { createHash } = await import('node:crypto');
      const activityId = 'mleverage_' + createHash('sha256').update([p.source,p.companyScopeId,p.homepageScopeId,p.sourceId.toLowerCase()].join(':')).digest('hex');
      return Response.json({ok:true,customerId:'${customerId}',activityId,created:false,duplicate:true});
    }; import(process.argv[1])`
    for (const entry of [source, bundle]) {
      const invoke = (args: string[], overrides: Record<string, string | undefined> = {}) => {
        const child = spawnSync(process.execPath, [
          ...(entry === source ? ['--import', pathToFileURL(require.resolve('tsx')).href] : []),
          '--input-type=module', '--eval', startup, pathToFileURL(entry).href, ...args,
        ], { cwd: temp, env: {
          NODE_ENV: 'production', TSX_TSCONFIG_PATH: path.join(root, 'tsconfig.json'), ...env, ...overrides,
        }, encoding: 'utf8', timeout: 10_000 })
        assert.equal(child.error, undefined)
        assert.equal(child.stderr, '', 'CLI never prints raw exceptions')
        noPrivateValues(child.stdout)
        assert.equal(child.stdout.includes(sourceId(1)), false, 'no source ID on stdout')
        assert.equal(child.stdout.includes(customerId), false, 'no customer ID on stdout')
        assert.equal(child.stdout.includes(temp), false, 'no supplied path on stdout')
        return { code: child.status, value: JSON.parse(child.stdout) }
      }
      for (const args of [[], ['other', privateError], ['plan', 'missing'], ['apply', 'missing', '--approve-sha256'], ['apply', 'missing', '--approve-sha256', 'x', 'extra']]) {
        const result = invoke(args)
        assert.equal(result.code, 1)
        assert.match(result.value.status, /^usage:/)
      }
      const idsFile = path.join(temp, `${entry === source ? 'source' : 'bundle'}-ids.json`)
      const planFile = idsFile + '.plan'
      await writeFile(idsFile, JSON.stringify([sourceId(1)]), { mode: 0o600 })
      for (const key of [undefined, '', 'short', ` ${'x'.repeat(32)}`]) {
        const result = invoke(['apply', planFile, '--approve-sha256', '0'.repeat(64)], {
          WARP_MARKETING_API_KEY: key, DATABASE_URL: `file:${temp}/must-not-create.db`,
        })
        assert.equal(result.value.status, 'warp_key_required')
      }
      await assert.rejects(stat(path.join(temp, 'must-not-create.db')))
      assert.equal(invoke(['plan', idsFile, planFile]).value.status, 'warp_recovery_database_required')
      await withWorkerDatabase(async db => {
        const row = await add(db, 1, true)
        const files = await db.$queryRawUnsafe<Array<{ file: string }>>('PRAGMA database_list')
        const databaseEnv = { DATABASE_URL: `file:${files[0].file}` }
        const planEnv = { ...databaseEnv, WARP_MARKETING_API_KEY: undefined }
        await chmod(idsFile, 0o644)
        assert.equal(invoke(['plan', idsFile, planFile], planEnv).code, 1, 'source ID input must be private too')
        await chmod(idsFile, 0o600)
        const planned = invoke(['plan', idsFile, planFile], planEnv)
        assert.equal(planned.code, 0)
        assert.equal(planned.value.comparison, 'local-only')
        assert.equal(planned.value.selected, 1)
        assert.equal((await stat(planFile)).mode & 0o777, 0o600)
        const text = await readFile(planFile, 'utf8')
        noPrivateValues(text)
        assert.equal(planned.value.sha256, recoverySha256(text))
        assert.equal(parseRecoveryPlan(text, planned.value.sha256).rows.length, 1)
        assert.equal(invoke(['plan', idsFile, planFile], databaseEnv).code, 1, 'existing plan is never overwritten')
        const args = ['apply', planFile, '--approve-sha256', planned.value.sha256]
        assert.equal(invoke(['apply', planFile, '--approve-sha256', '0'.repeat(64)], databaseEnv).value.status, 'warp_recovery_approval_mismatch')
        await chmod(planFile, 0o644)
        assert.equal(invoke(args, databaseEnv).code, 1)
        await chmod(planFile, 0o600)
        await chmod(temp, 0o755)
        assert.equal(invoke(args, databaseEnv).code, 1)
        await chmod(temp, 0o700)
        const link = planFile + '.link'
        await symlink(planFile, link)
        assert.equal(invoke(['apply', link, '--approve-sha256', planned.value.sha256], databaseEnv).code, 1)
        const directoryLink = idsFile + '.directory-link'
        await symlink(temp, directoryLink)
        const linkedPlan = path.join(directoryLink, path.basename(planFile))
        assert.equal(invoke(['apply', linkedPlan, '--approve-sha256', planned.value.sha256], databaseEnv).code, 1)
        const linkedOutput = path.join(directoryLink, 'must-not-create.plan')
        assert.equal(invoke(['plan', idsFile, linkedOutput], planEnv).code, 1)
        assert.equal(invoke(['plan', path.join(directoryLink, path.basename(idsFile)), planFile + '.other'], planEnv).code, 1)
        // The immediate parent is real; only a higher ancestor is a symlink.
        const nested = idsFile + '.nested'
        await mkdir(nested, { mode: 0o700 })
        assert.equal(invoke(['plan', idsFile, path.join(directoryLink, path.basename(nested), 'must-not-create.plan')], planEnv).code, 1)
        // Do not normalize away a symlink/.. traversal before checking the path.
        assert.equal(invoke(['plan', idsFile, `${directoryLink}/../${path.basename(temp)}/must-not-create.plan`], planEnv).code, 1)
        assert.deepEqual(await readdir(nested), [])
        await assert.rejects(stat(path.join(temp, 'must-not-create.plan')))
        const restrictive = planFile + '.restrictive-umask'
        assert.equal(invoke(['plan', idsFile, restrictive], { ...planEnv, SYNTHETIC_UMASK: '511' }).code, 0)
        assert.equal((await stat(restrictive)).mode & 0o7777, 0o600, 'output remains exactly 0600 even under a restrictive umask')
        const applied = invoke(args, databaseEnv)
        assert.equal(applied.code, 0)
        assert.deepEqual(applied.value, { status: 'ok', selected: 1, attempted: 1, confirmed: 1, created: 0, duplicate: 1 })
        assert.deepEqual(await db.inquiry.findUniqueOrThrow({ where: { id: row.id } }), row)
        const audits = (await readdir(temp)).filter(file => file.startsWith(path.basename(planFile) + '.apply-'))
        assert.equal(audits.length, 1)
        const auditPath = path.join(temp, audits[0])
        assert.equal((await stat(auditPath)).mode & 0o777, 0o600)
        const auditText = await readFile(auditPath, 'utf8')
        noPrivateValues(auditText)
        assert.deepEqual(auditText.trim().split('\n').map(line => JSON.parse(line).event), ['start', 'attempt', 'receipt', 'finish'])
      })
    }
  } finally { await rm(temp, { recursive: true, force: true }) }
}

async function main() {
  await testAsymmetricRecovery()
  await testApprovalAndDrift()
  await testFailureAndRetry()
  await testStopLeaseAndMidRunDrift()
  await testBound()
  await testCli()
  console.log('warp recovery passed: asymmetric restore, receipt preservation, bounded replay, exact approval, drift/key/lease guards, stop, private source and packaged CLI')
}

const timeout = setTimeout(() => { throw new Error('warp recovery tests timed out') }, 60_000)
main().catch(error => { console.error(error); process.exitCode = 1 }).finally(() => clearTimeout(timeout))
