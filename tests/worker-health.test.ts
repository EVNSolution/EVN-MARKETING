import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { symlink, unlink } from 'node:fs/promises'
import { INQUIRY_SCOPE_ID, claimWorker } from '@/lib/inquiry-sync'
import { configuredWorkerOwner, readWorkerHealth } from '@/lib/worker-health'
import { withWorkerDatabase } from './worker-runtime-helper'

async function main() {
  const owner = '00000000-0000-4000-8000-000000000001'
  assert.equal(configuredWorkerOwner({ NODE_ENV: 'test' }), undefined, 'local execution keeps random owner default')
  assert.throws(() => configuredWorkerOwner({ NODE_ENV: 'production' }), /invalid_worker_owner/)
  assert.throws(() => configuredWorkerOwner({ NODE_ENV: 'test', MARKETING_WORKER_OWNER: 'unsafe-value' }), /invalid_worker_owner/)
  assert.equal(configuredWorkerOwner({ NODE_ENV: 'test', MARKETING_WORKER_OWNER: owner }), owner)
  await withWorkerDatabase(async (db) => {
    const [{ file }] = await db.$queryRawUnsafe<{ file: string }[]>('PRAGMA database_list')
    const now = new Date()
    const env: NodeJS.ProcessEnv = {
      NODE_ENV: 'production', MARKETING_WORKER_OWNER: owner, DATABASE_URL: `file:${file}`,
      MARKETING_REVISION: 'a'.repeat(40), MARKETING_IMAGE_DIGEST: `sha256:${'b'.repeat(64)}`,
    }
    assert.deepEqual(await readWorkerHealth(env, now), { ok: false, reason: 'owner' })
    assert.equal(await claimWorker(db, owner, now), true)
    assert.deepEqual(await readWorkerHealth(env, now), { ok: false, reason: 'source' }, 'starting is not source readiness')
    const update = (data: Parameters<typeof db.inquirySyncState.update>[0]['data']) => db.inquirySyncState.update({ where: { id: INQUIRY_SCOPE_ID }, data })
    await update({ status: 'ready' })
    const before = await db.inquirySyncState.findMany()
    const healthy = await readWorkerHealth(env, now)
    assert.deepEqual(healthy, { ok: true, revision: env.MARKETING_REVISION, imageDigest: env.MARKETING_IMAGE_DIGEST, heartbeatAt: now.toISOString(), lastSuccessfulAt: null })
    assert.deepEqual(await db.inquirySyncState.findMany(), before, 'health must not renew leases or alter source state')
    assert.deepEqual(await readWorkerHealth({ ...env, MARKETING_WORKER_OWNER: '00000000-0000-4000-8000-000000000002' }, now), { ok: false, reason: 'owner' })
    for (const status of ['login_required', 'credentials_invalid', 'partial', 'failed', 'offline', 'source_error', 'sensitive raw failure']) {
      await update({ status })
      assert.deepEqual(await readWorkerHealth(env, now), { ok: false, reason: 'source' }, 'raw source errors never reach health output')
    }
    for (const status of ['ready', 'running', 'success']) {
      await update({ status, lastSuccessfulAt: now })
      assert.equal((await readWorkerHealth(env, now)).ok, true)
    }
    for (const data of [
      { workerHeartbeatAt: null },
      { workerHeartbeatAt: new Date(now.getTime() - 180_000) },
      { workerHeartbeatAt: new Date(now.getTime() + 6_000) },
      { workerLeaseExpiresAt: now },
      { workerLeaseExpiresAt: null },
    ]) {
      await update({ workerHeartbeatAt: now, workerLeaseExpiresAt: new Date(now.getTime() + 180_000), ...data })
      assert.deepEqual(await readWorkerHealth(env, now), { ok: false, reason: 'lease' })
    }
    await update({ workerOwner: null })
    assert.deepEqual(await readWorkerHealth(env, now), { ok: false, reason: 'owner' })
    assert.equal((await readWorkerHealth({ ...env, MARKETING_REVISION: '' }, now)).ok, false)
    assert.equal((await readWorkerHealth({ ...env, MARKETING_IMAGE_DIGEST: 'invalid' }, now)).ok, false)
    assert.equal((await readWorkerHealth({ ...env, MARKETING_WORKER_OWNER: '' }, now)).ok, false)
    const missing = `${file}.missing`
    assert.equal((await readWorkerHealth({ ...env, DATABASE_URL: `file:${missing}` }, now)).ok, false)
    assert.equal(existsSync(missing), false, 'health cannot initialize a missing DB')
    await symlink(file, `${file}.link`)
    try {
      assert.deepEqual(await readWorkerHealth({ ...env, DATABASE_URL: `file:${file}.link` }, now), { ok: false, reason: 'database' })
    } finally { await unlink(`${file}.link`) }
  })
  console.log('worker health: readonly owner, source, lease, configuration and missing DB checks passed')
}

main().catch((error) => { console.error(error); process.exitCode = 1 })
