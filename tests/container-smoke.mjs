import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'

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
console.log('synthetic SQLite user and headless Chromium passed')
