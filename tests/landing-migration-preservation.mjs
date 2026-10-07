// CI-only comparison of independently verified, coherent pre/post-migration bundles.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'

const Database = createRequire('/app/package.json')('better-sqlite3')
const [beforeDirectory, afterDirectory] = process.argv.slice(2)
assert.equal(process.argv.length, 4)
const inventory = directory => JSON.parse(readFileSync(path.join(directory, 'inventory.json'), 'utf8'))
const before = inventory(beforeDirectory), after = inventory(afterDirectory)
assert.deepEqual(after.files, before.files, 'all upload paths, bytes and hashes must survive the migration')
assert.deepEqual(after.delivery, before.delivery, 'existing WARP delivery receipts must survive')
assert.deepEqual(Object.keys(after.rows).filter(k => !(k in before.rows)).sort(), ['LandingReceipt','LandingThrottle'])
for (const table of Object.keys(before.rows).filter(k => k !== '_prisma_migrations')) {
  assert.equal(after.rows[table], before.rows[table], `existing row count: ${table}`)
  assert.equal(after.hashes[table], before.hashes[table], `existing content hash: ${table}`)
}
for (const table of ['LandingReceipt','LandingThrottle']) assert.equal(after.rows[table], 0)
const original = new Database(path.join(beforeDirectory, 'marketing.db'), { readonly:true, fileMustExist:true })
const migrated = new Database(path.join(afterDirectory, 'marketing.db'), { readonly:true, fileMustExist:true })
try {
  const read = db => db.prepare('SELECT * FROM _prisma_migrations ORDER BY id').all()
  const existing = read(original), actual = read(migrated)
  const added = actual.filter(row => row.migration_name === '20261007000100_landing_inquiries')
  assert.equal(added.length, 1)
  assert.ok(added[0].finished_at && added[0].rolled_back_at === null)
  assert.deepEqual(actual.filter(row => row.migration_name !== '20261007000100_landing_inquiries'), existing,
    'Prisma must preserve every previous migration ledger row')
} finally { original.close(); migrated.close() }
console.log('PASS: formal migration preserves existing rows, WARP receipts, uploads and ledger; exactly two empty tables added')
