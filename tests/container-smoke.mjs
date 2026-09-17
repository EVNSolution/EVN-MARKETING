import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'

const require = createRequire('/app/package.json')
assert.notEqual(process.getuid(), 0)
for (const path of [
  '/app/node_modules/prisma',
  '/app/node_modules/@prisma/config',
  '/app/node_modules/mysql2',
  '/app/node_modules/deepmerge-ts',
  '/app/node_modules/eslint',
  '/app/node_modules/typescript',
  '/app/node_modules/tsx',
  '/app/prisma/seed.ts',
  '/app/tests',
]) assert.equal(existsSync(path), false, `build-only path present: ${path}`)
const Database = require('better-sqlite3')
const { chromium } = require('playwright-core')
const db = new Database('/data/marketing.db')
try {
  for (const migration of ['20260915000100_baseline', '20260915000200_inquiry_sync', '20260915000300_warp_delivery']) {
    db.exec(readFileSync(`/src/prisma/migrations/${migration}/migration.sql`, 'utf8'))
  }
  db.prepare('INSERT INTO Team (id, name) VALUES (?, ?)').run('synthetic-team', 'Synthetic team')
  db.prepare('INSERT INTO User (id, name, email, password, role, teamId, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run('synthetic-user', 'Synthetic user', 'synthetic@example.invalid', '$2b$04$jE4nbrd/N17cKY7MeSCLm.JElVzGnH4VIqBbdq.M1R6qhLvQYdIjG', 'user', 'synthetic-team', new Date().toISOString())
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM User').get().count, 1)
} finally {
  db.close()
}
const browser = await chromium.launch({ headless: true })
await browser.close()
// The CI container has no external network; dummy credentials can never reach the source.
const worker = spawnSync(process.execPath, ['/app/worker.mjs'], {
  env: { ...process.env, DATABASE_URL: 'file:/data/marketing.db', MLEVERAGE_USERNAME: 'synthetic-user', MLEVERAGE_PASSWORD: 'synthetic-password', WARP_DELIVERY_ENABLED: 'false' },
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
console.log('synthetic SQLite, Chromium, packaged worker and lease cleanup passed')
