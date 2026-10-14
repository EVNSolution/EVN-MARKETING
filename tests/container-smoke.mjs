import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import { recordSyntheticMigrations } from './schema-fixture.mjs'

const require = createRequire('/app/package.json')
assert.notEqual(process.getuid(), 0)
const nativeCharset = spawnSync('locale', ['charmap'], { encoding: 'utf8' })
assert.equal(nativeCharset.status, 0)
assert.match(nativeCharset.stdout.trim(), /^UTF-?8$/i, 'Chromium must preserve Korean download names in the runtime filesystem encoding')
for (const path of [
  '/app/node_modules/prisma',
  '/app/node_modules/@prisma/config',
  '/app/node_modules/mysql2',
  '/app/node_modules/deepmerge-ts',
  '/app/node_modules/eslint',
  '/app/node_modules/typescript',
  '/app/node_modules/tsx',
  '/app/node_modules/esbuild',
  '/app/prisma/seed.ts',
  '/app/scripts',
  '/app/workers',
  '/app/tests',
]) assert.equal(existsSync(path), false, `build-only path present: ${path}`)
assert.equal(existsSync('/app/warp-delivery.mjs'), true, 'packaged WARP CLI is present')
assert.equal(existsSync('/app/warp-recovery.mjs'), true, 'packaged recovery CLI is present')
assert.equal(existsSync('/app/worker-health.mjs'), true, 'packaged worker health CLI is present')
assert.equal(existsSync('/app/landing-expansion-audit.mjs'), true, 'packaged read-only expansion audit is present')
const Database = require('better-sqlite3')
const { chromium } = require('playwright-core')
mkdirSync('/data/uploads', { recursive: true })
writeFileSync('/data/.marketing-volume-id', 'synthetic-volume-ci\n', { flag: 'wx', mode: 0o600 })
const inquiry = {
  source: 'mleverage-admin',
  companyScopeId: '55f9a8bb-73f9-4316-bcd7-7dcdce0bdcc3',
  homepageScopeId: '5c7a6115-a0a9-4e8d-bf65-efce52195fa4',
  sourceId: '00000000-0000-4000-8000-000000000001',
  inquiryDate: '2026-09-15', inquiryTime: '09:07', sourceStatus: '', name: '', phone: '010-0000-0000',
}
const activityId = `mleverage_${createHash('sha256').update([
  inquiry.source, inquiry.companyScopeId, inquiry.homepageScopeId, inquiry.sourceId,
].join(':')).digest('hex')}`
const db = new Database('/data/marketing.db')
try {
  for (const migration of ['20260915000100_baseline', '20260915000200_inquiry_sync', '20260915000300_warp_delivery', '20261007000100_landing_inquiries']) {
    db.exec(readFileSync(`/src/prisma/migrations/${migration}/migration.sql`, 'utf8'))
  }
  recordSyntheticMigrations(db, '/src')
  db.prepare('INSERT INTO Team (id, name) VALUES (?, ?)').run('synthetic-team', 'Synthetic team')
  db.prepare('INSERT INTO User (id, name, email, password, role, teamId, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run('synthetic-user', 'Synthetic user', 'synthetic@example.invalid', '$2b$04$jE4nbrd/N17cKY7MeSCLm.JElVzGnH4VIqBbdq.M1R6qhLvQYdIjG', 'user', 'synthetic-team', new Date().toISOString())
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM User').get().count, 1)
  db.prepare('INSERT INTO Inquiry (id, source, companyScopeId, homepageScopeId, sourceId, inquiryDate, inquiryTime, phone, lastSeenAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run('synthetic-inquiry', inquiry.source, inquiry.companyScopeId, inquiry.homepageScopeId, inquiry.sourceId, inquiry.inquiryDate, inquiry.inquiryTime, inquiry.phone, new Date().toISOString())
} finally {
  db.close()
}
const beforeCli = readFileSync('/data/marketing.db')
const recoveryRejected = spawnSync(process.execPath, ['/app/warp-recovery.mjs', 'apply', '/missing', '--approve-sha256', 'a'.repeat(64)], {
  env: { DATABASE_URL: 'file:/data/must-not-create.db' }, encoding: 'utf8', timeout: 10_000,
})
assert.equal(recoveryRejected.status, 1)
assert.equal(recoveryRejected.stderr, '')
assert.deepEqual(JSON.parse(recoveryRejected.stdout), { status: 'warp_key_required' })
assert.equal(existsSync('/data/must-not-create.db'), false)
const schemaCli = (database) => spawnSync(process.execPath, ['/app/schema-check.mjs', 'check', '/app/schema-manifest.json', '/app/schema-manifest.json'], {
  env: { DATABASE_URL: database }, encoding: 'utf8', timeout: 5000,
})
assert.equal(schemaCli('file:/data/marketing.db').status, 0, 'packaged schema gate reads its image manifest')
const expansionAudit = spawnSync(process.execPath, ['/app/landing-expansion-audit.mjs', 'expanded', '/data'], {
  env: {}, encoding: 'utf8', timeout: 5000,
})
assert.equal(expansionAudit.status, 0, 'packaged expansion auditor recognizes the exact expanded schema')
assert.equal(JSON.parse(expansionAudit.stdout).ok, true)
const missingSchemaDb = schemaCli('file:/data/schema-must-not-create.db')
assert.equal(missingSchemaDb.status, 1)
assert.equal(missingSchemaDb.stderr, '')
assert.equal(JSON.parse(missingSchemaDb.stdout).ok, false)
assert.equal(existsSync('/data/schema-must-not-create.db'), false)
assert.deepEqual(readFileSync('/data/marketing.db'), beforeCli, 'schema gate leaves data and ledger unchanged')
for (const mode of ['check', 'pilot']) {
  for (const databaseUrl of [undefined, 'file:/data/marketing.db']) {
    const cli = spawnSync(process.execPath, ['/app/warp-delivery.mjs', mode], {
      env: { ...process.env, NODE_ENV: 'production', DATABASE_URL: databaseUrl, WARP_MARKETING_API_KEY: '', WARP_DELIVERY_ENABLED: 'true' },
      encoding: 'utf8', timeout: 10_000,
    })
    assert.equal(cli.status, 1, `${mode} must reject a missing key before DB access`)
    assert.equal(cli.stdout.trim(), 'warp_key_required')
    assert.equal(cli.stderr, '')
    assert.deepEqual(readFileSync('/data/marketing.db'), beforeCli, 'rejected CLI must preserve the synthetic DB')
    for (const suffix of ['-wal', '-shm', '-journal']) assert.equal(existsSync(`/data/marketing.db${suffix}`), false)
  }
}
const cliVerified = new Database('/data/marketing.db', { readonly: true })
try {
  assert.equal(cliVerified.prepare('SELECT COUNT(*) AS count FROM InquirySyncState').get().count, 0, 'rejected pilot must not create a worker lease')
} finally {
  cliVerified.close()
}
function runPackagedPilot(expectedCalls) {
  // The stub lives only in this child process; the application keeps its pinned endpoint.
  const stub = `
    import assert from 'node:assert/strict';
    let calls = 0, checks = 0;
    globalThis.fetch = async (url, init) => {
      if (url === 'https://warp.cleversystem.ai/api/external/marketing-inquiries/check') {
        checks++;
        assert.equal(init.method, 'POST');
        assert.equal(init.redirect, 'error');
        assert.equal(new Headers(init.headers).get('x-api-key'), process.env.WARP_MARKETING_API_KEY);
        assert.deepEqual(JSON.parse(init.body), ${JSON.stringify({ source: inquiry.source, companyScopeId: inquiry.companyScopeId, homepageScopeId: inquiry.homepageScopeId, items: [{ sourceId: inquiry.sourceId, phone: inquiry.phone }] })});
        return Response.json({ ok: true, results: [{ sourceId: ${JSON.stringify(inquiry.sourceId)}, exists: false }] });
      }
      calls++;
      assert.equal(url, 'https://warp.cleversystem.ai/api/external/marketing-inquiries');
      assert.equal(init.method, 'POST');
      assert.equal(init.redirect, 'error');
      assert.equal(new Headers(init.headers).get('x-api-key'), process.env.WARP_MARKETING_API_KEY);
      assert.deepEqual(JSON.parse(init.body), ${JSON.stringify({ ...inquiry, name: '미상(📞 0000)', rejectExistingCustomer: true })});
      return Response.json({ ok: true, customerId: 'synthetic-customer', activityId: ${JSON.stringify(activityId)}, created: calls === 1, duplicate: calls === 2 });
    };
    process.once('exit', () => {
      assert.equal(calls, ${expectedCalls}, 'packaged pilot write count');
      assert.equal(checks, ${expectedCalls ? 1 : 0}, 'packaged pilot read-only check count');
    });
    await import('/app/warp-delivery.mjs');
  `
  return spawnSync(process.execPath, ['--input-type=module', '--eval', stub, '/app/warp-delivery.mjs', 'pilot'], {
    env: { NODE_ENV: 'production', DATABASE_URL: 'file:/data/marketing.db', WARP_MARKETING_API_KEY: 'synthetic-test-key-never-used-in-production', WARP_DELIVERY_ENABLED: 'false' },
    encoding: 'utf8', timeout: 15_000,
  })
}
const pilot = runPackagedPilot(2)
assert.equal(pilot.status, 0, 'packaged pilot must load runtime DB dependencies, send and replay')
assert.equal(pilot.stdout.trim(), 'ok')
assert.equal(pilot.stderr, '')
const pilotDb = new Database('/data/marketing.db')
try {
  const receipt = pilotDb.prepare('SELECT * FROM Inquiry WHERE id = ?').get('synthetic-inquiry')
  assert.equal(receipt.name, null, 'delivery fills the wire name without rewriting the legacy source record')
  assert.equal(receipt.warpCustomerId, 'synthetic-customer')
  assert.equal(receipt.warpActivityId, activityId)
  assert.ok(receipt.warpDeliveredAt)
  assert.ok(receipt.warpAttemptedAt)
  assert.equal(receipt.warpError, null)
  assert.deepEqual(pilotDb.prepare('SELECT workerOwner, workerLeaseExpiresAt FROM InquirySyncState').all(), [{ workerOwner: null, workerLeaseExpiresAt: null }])

  const busyUntil = new Date(Date.now() + 60_000).toISOString()
  pilotDb.prepare('UPDATE InquirySyncState SET workerOwner = ?, workerLeaseExpiresAt = ?').run('synthetic-busy-worker', busyUntil)
  try {
    const busy = runPackagedPilot(0)
    assert.equal(busy.status, 1)
    assert.equal(busy.stdout.trim(), 'worker_already_running')
    assert.equal(busy.stderr, '')
    assert.deepEqual(pilotDb.prepare('SELECT workerOwner, workerLeaseExpiresAt FROM InquirySyncState').all(), [{ workerOwner: 'synthetic-busy-worker', workerLeaseExpiresAt: busyUntil }], 'rejected pilot preserves the other owner')
    assert.deepEqual(pilotDb.prepare('SELECT * FROM Inquiry WHERE id = ?').get('synthetic-inquiry'), receipt, 'rejected pilot preserves the saved receipt')
  } finally {
    pilotDb.prepare('UPDATE InquirySyncState SET workerOwner = NULL, workerLeaseExpiresAt = NULL WHERE workerOwner = ?').run('synthetic-busy-worker')
  }
} finally {
  pilotDb.close()
}
const browser = await chromium.launch({ headless: true })
mkdirSync('/data/recovery', { mode: 0o700 })
writeFileSync('/data/recovery/ids.json', JSON.stringify([inquiry.sourceId]), { mode: 0o600, flag: 'wx' })
const recoveryPlan = spawnSync(process.execPath, ['/app/warp-recovery.mjs', 'plan', '/data/recovery/ids.json', '/data/recovery/plan.json'], {
  env: { DATABASE_URL: 'file:/data/marketing.db' }, encoding: 'utf8', timeout: 10_000,
})
assert.equal(recoveryPlan.status, 0, 'packaged offline planning loads runtime dependencies without a key')
assert.equal(recoveryPlan.stderr, '')
const planResult = JSON.parse(recoveryPlan.stdout)
assert.equal(planResult.comparison, 'local-only')
assert.equal(planResult.selected, 1)
assert.equal(planResult.sha256, createHash('sha256').update(readFileSync('/data/recovery/plan.json')).digest('hex'))
await browser.close()
// The CI container has no external network; dummy credentials can never reach the source.
const worker = spawnSync(process.execPath, ['/app/worker.mjs'], {
  env: { ...process.env, INQUIRY_COLLECTOR_ENABLED: 'true', MARKETING_WORKER_OWNER: '00000000-0000-4000-8000-000000000001', DATABASE_URL: 'file:/data/marketing.db', MLEVERAGE_USERNAME: 'synthetic-user', MLEVERAGE_PASSWORD: 'synthetic-password', WARP_DELIVERY_ENABLED: 'false' },
  encoding: 'utf8', timeout: 60_000,
})
assert.equal(worker.status, 1, 'worker must stop when the source is unreachable')
assert.match(worker.stderr.trim(), /^(offline_ERR_[A-Z_]+|page_error)$/, 'worker must reach source navigation without module or database errors')
const verified = new Database('/data/marketing.db', { readonly: true })
try {
  const state = verified.prepare('SELECT workerOwner FROM InquirySyncState').all()
  assert.equal(state.length, 1)
  assert.equal(state[0].workerOwner, null, 'failed source navigation must release the worker lease')
} finally {
  verified.close()
}
const healthEnv = {
  NODE_ENV: 'production', DATABASE_URL: 'file:/data/marketing.db',
  MARKETING_WORKER_OWNER: '00000000-0000-4000-8000-000000000001',
  MARKETING_REVISION: 'a'.repeat(40), MARKETING_IMAGE_DIGEST: `sha256:${'b'.repeat(64)}`,
}
const health = (overrides = {}) => spawnSync(process.execPath, ['/app/worker-health.mjs'], {
  env: { ...healthEnv, ...overrides }, encoding: 'utf8', timeout: 5_000,
})
const healthDb = new Database('/data/marketing.db')
try {
  const previous = healthDb.prepare('SELECT * FROM InquirySyncState').get()
  const now = new Date()
  const set = healthDb.prepare('UPDATE InquirySyncState SET workerOwner = ?, workerHeartbeatAt = ?, workerLeaseExpiresAt = ?, status = ?')
  try {
    set.run(healthEnv.MARKETING_WORKER_OWNER, now.toISOString(), new Date(now.getTime() + 180_000).toISOString(), 'ready')
    const before = healthDb.prepare('SELECT * FROM InquirySyncState').get()
    const ready = health()
    assert.equal(ready.status, 0, 'packaged readonly health loads without development dependencies')
    assert.equal(ready.stderr, '')
    assert.equal(JSON.parse(ready.stdout).ok, true)
    assert.equal(JSON.parse(ready.stdout).revision, healthEnv.MARKETING_REVISION)
    assert.deepEqual(healthDb.prepare('SELECT * FROM InquirySyncState').get(), before, 'health leaves lease and schedule untouched')
    for (const overrides of [
      { MARKETING_WORKER_OWNER: '00000000-0000-4000-8000-000000000002' },
      { MARKETING_WORKER_OWNER: '' },
      { MARKETING_IMAGE_DIGEST: '' },
      { DATABASE_URL: 'file:/data/must-not-create.db' },
    ]) {
      const rejected = health(overrides)
      assert.equal(rejected.status, 1)
      assert.equal(rejected.stderr, '')
      assert.equal(JSON.parse(rejected.stdout).ok, false)
    }
    assert.equal(existsSync('/data/must-not-create.db'), false)
    set.run(healthEnv.MARKETING_WORKER_OWNER, now.toISOString(), new Date(now.getTime() - 1).toISOString(), 'ready')
    assert.deepEqual(JSON.parse(health().stdout), { ok: false, reason: 'lease' })
    set.run(healthEnv.MARKETING_WORKER_OWNER, now.toISOString(), new Date(now.getTime() + 180_000).toISOString(), 'login_required')
    assert.deepEqual(JSON.parse(health().stdout), { ok: false, reason: 'source' })
  } finally {
    set.run(previous.workerOwner, previous.workerHeartbeatAt, previous.workerLeaseExpiresAt, previous.status)
  }
} finally { healthDb.close() }
const invalidWorker = spawnSync(process.execPath, ['/app/worker.mjs'], {
  env: { NODE_ENV: 'production', INQUIRY_COLLECTOR_ENABLED: 'true', DATABASE_URL: 'file:/data/must-not-create.db' }, encoding: 'utf8', timeout: 5_000,
})
assert.equal(invalidWorker.status, 1, 'production worker needs a unique configured owner before any DB access')
assert.equal(invalidWorker.stderr.trim(), 'invalid_worker_owner')
assert.equal(existsSync('/data/must-not-create.db'), false)
console.log('synthetic SQLite, Chromium, packaged pilot/replay, busy lease, worker cleanup and readonly worker health passed')
