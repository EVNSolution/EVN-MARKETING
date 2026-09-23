import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { checkSchema, createManifest } from '../scripts/schema-check.mjs'
import { recordSyntheticMigrations } from './schema-fixture.mjs'

const require = createRequire(import.meta.url)
const Database = require('better-sqlite3')
const root = process.cwd()
const current = createManifest(root, 'a'.repeat(40))
const previous = { ...current, revision: 'b'.repeat(40) }
const directory = realpathSync(mkdtempSync(path.join(tmpdir(), 'marketing-schema-test-')))
let number = 0
function fixture(change = () => {}) {
  const file = path.join(directory, `${number++}.db`)
  const db = new Database(file)
  try {
    for (const { name } of current.migrations) db.exec(readFileSync(path.join(root, 'prisma/migrations', name, 'migration.sql'), 'utf8'))
    recordSyntheticMigrations(db, root)
    change(db)
  } finally { db.close() }
  return file
}
function reject(change, reason) {
  const file = fixture(change)
  const before = readFileSync(file)
  assert.throws(() => checkSchema(file, current, previous), new RegExp(reason))
  assert.deepEqual(readFileSync(file), before, 'failure must not repair or initialize data')
}
try {
  const file = fixture()
  const before = readFileSync(file)
  assert.equal(checkSchema(file, current, previous).ok, true)
  assert.deepEqual(readFileSync(file), before)
  const migration = current.migrations[0].name
  reject(db => db.exec('DROP TABLE _prisma_migrations'), 'migration_ledger')
  reject(db => db.prepare('UPDATE _prisma_migrations SET checksum = ? WHERE migration_name = ?').run('0'.repeat(64), migration), 'migration_ledger')
  reject(db => db.prepare('UPDATE _prisma_migrations SET finished_at = NULL WHERE migration_name = ?').run(migration), 'migration_ledger')
  reject(db => db.prepare('UPDATE _prisma_migrations SET rolled_back_at = ? WHERE migration_name = ?').run('2026-09-22', migration), 'migration_ledger')
  reject(db => db.exec("INSERT INTO _prisma_migrations SELECT 'duplicate', migration_name, checksum, started_at, finished_at, rolled_back_at, logs, applied_steps_count FROM _prisma_migrations LIMIT 1"), 'migration_ledger')
  reject(db => db.exec("INSERT INTO _prisma_migrations VALUES ('unknown', '20269999000000_unknown', 'hash', 'now', 'now', NULL, NULL, 1)"), 'migration_ledger')
  reject(db => db.exec('ALTER TABLE Inquiry RENAME COLUMN warpActivityId TO missingReceipt'), 'schema')
  reject(db => db.exec('ALTER TABLE Customer ADD COLUMN unsafeRequired TEXT NOT NULL'), 'schema')
  reject(db => db.exec('ALTER TABLE Customer ADD COLUMN optionalExpand TEXT'), 'schema')
  reject(db => db.exec('DROP INDEX Inquiry_source_companyScopeId_homepageScopeId_sourceId_key'), 'schema')
  reject(db => db.exec("CREATE TRIGGER extra_write AFTER INSERT ON Customer BEGIN DELETE FROM Inquiry; END"), 'schema')
  reject(db => {
    db.pragma('foreign_keys = OFF')
    db.exec("INSERT INTO CustomerActivity (id, customerId, type, date) VALUES ('synthetic-orphan', 'missing-customer', '전화', '2026-09-22')")
  }, 'integrity')

  for (const field of ['prismaSchemaSha256', 'migrations', 'schema']) {
    const changed = structuredClone(previous)
    if (field === 'prismaSchemaSha256') changed[field] = '0'.repeat(64)
    else if (field === 'migrations') changed.migrations[0].checksum = '0'.repeat(64)
    else changed.schema[0].sql += ' '
    assert.throws(() => checkSchema(file, current, changed), /schema_change_requires_review/)
  }
  const link = path.join(directory, 'link.db')
  symlinkSync(file, link)
  assert.throws(() => checkSchema(link, current, previous), /database_path/)
  const manifest = path.join(directory, 'manifest.json')
  writeFileSync(manifest, JSON.stringify(current))
  const run = (database, args = [manifest, manifest]) => spawnSync(process.execPath, ['scripts/schema-check.mjs', 'check', ...args], {
    env: { PATH: process.env.PATH, DATABASE_URL: database }, encoding: 'utf8', timeout: 5000,
  })
  assert.equal(run(`file:${file}`).status, 0)
  for (const url of ['', 'file:relative.db', `file:${directory}/missing.db`, 'https://synthetic-private.invalid']) {
    const result = run(url)
    assert.equal(result.status, 1)
    assert.equal(result.stderr, '')
    assert.equal(JSON.parse(result.stdout).ok, false)
    assert.ok(!result.stdout.includes(directory) && !result.stdout.includes('synthetic-private'))
  }
  assert.equal(existsSync(path.join(directory, 'missing.db')), false)
  assert.equal(run(`file:${file}`, []).status, 1)
  console.log('schema preflight passed: both manifests, exact DDL, ledger checksums/completion, constraints, readonly and safe CLI failures')
} finally { rmSync(directory, { recursive: true, force: true }) }
