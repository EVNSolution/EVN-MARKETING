import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { checkSchema } from '../scripts/schema-check.mjs'
import { annotateCompatibility, landingSchemaPolicy as policy, schemaContract } from '../scripts/schema-compatibility.mjs'

const Database = createRequire(import.meta.url)('better-sqlite3')
const directory = realpathSync(mkdtempSync(path.join(tmpdir(), 'landing-schema-bridge-')))
const original = structuredClone(policy.baseline)
const bridge = annotateCompatibility({ ...original, revision: 'b'.repeat(40) })
const feature = annotateCompatibility({ ...policy.expanded, revision: 'c'.repeat(40) })
let count = 0
function database(manifest, change = () => {}) {
  const file = path.join(directory, `${count++}.db`)
  const db = new Database(file)
  try {
    for (const type of ['table','index','trigger','view']) {
      for (const entry of manifest.schema.filter(s => s.type === type)) db.exec(entry.sql)
    }
    // Explicitly synthetic ledger. No production repair or baseline operation.
    db.exec('CREATE TABLE _prisma_migrations (id TEXT PRIMARY KEY, migration_name TEXT NOT NULL, checksum TEXT NOT NULL, finished_at DATETIME, rolled_back_at DATETIME)')
    for (const migration of manifest.migrations) db.prepare('INSERT INTO _prisma_migrations VALUES (?, ?, ?, ?, NULL)')
      .run(migration.name, migration.name, migration.checksum, '2026-10-07T00:00:00Z')
    db.prepare('INSERT INTO Customer (id, name, updatedAt) VALUES (?, ?, ?)').run('synthetic-existing', 'Synthetic existing customer', '2026-10-07T00:00:00Z')
    change(db)
  } finally { db.close() }
  return file
}
function accepts(file, a, b, expectedContract) {
  const before = readFileSync(file)
  assert.equal(checkSchema(file, a, b).storageContractSha256, expectedContract)
  assert.deepEqual(readFileSync(file), before, 'successful preflight is read-only')
}
function rejects(file, a, b, reason) {
  const before = readFileSync(file)
  assert.throws(() => checkSchema(file, a, b), new RegExp(reason))
  assert.deepEqual(readFileSync(file), before, 'rejection must not repair data')
}
try {
  const baseDb = database(original), expandedDb = database(feature)
  const baseContract = schemaContract(original), expandedContract = schemaContract(feature)
  // Bridge release and rollback before migration are ordinary unchanged-schema operations.
  accepts(baseDb, bridge, original, baseContract)
  accepts(baseDb, original, bridge, baseContract)
  accepts(baseDb, bridge, bridge, baseContract)
  // Recovery of the bridge and both directions of feature release after expansion.
  accepts(expandedDb, bridge, bridge, expandedContract)
  accepts(expandedDb, feature, bridge, expandedContract)
  accepts(expandedDb, bridge, feature, expandedContract)
  accepts(expandedDb, feature, feature, expandedContract)
  // Original runtime is never a valid target after expansion. Migration is never automatic.
  rejects(expandedDb, feature, original, 'schema_change_requires_review')
  rejects(expandedDb, original, feature, 'schema_change_requires_review')
  rejects(expandedDb, bridge, original, 'schema')
  rejects(expandedDb, original, bridge, 'schema')
  rejects(baseDb, feature, bridge, 'schema')
  rejects(baseDb, bridge, feature, 'schema')
  const unsupported = { ...bridge, schemaCompatibility: { landingExpansion: '0'.repeat(64) } }
  rejects(expandedDb, feature, unsupported, 'schema_change_requires_review')
  for (const field of ['prismaSchemaSha256', 'migrations', 'schema']) {
    const changed = structuredClone(feature)
    if (field === 'prismaSchemaSha256') changed[field] = '0'.repeat(64)
    else if (field === 'migrations') changed.migrations.at(-1).checksum = '0'.repeat(64)
    else changed.schema[0].sql += ' '
    rejects(expandedDb, changed, bridge, 'schema_change_requires_review')
  }
  for (const edit of [
    db => db.exec('ALTER TABLE Customer ADD COLUMN unreviewed TEXT'),
    db => db.exec('DROP TABLE LandingReceipt'),
    db => db.exec('DROP INDEX LandingThrottle_windowStart_idx'),
    db => db.exec('CREATE TRIGGER unrelated AFTER INSERT ON LandingReceipt BEGIN DELETE FROM Customer; END'),
  ]) rejects(database(feature, edit), bridge, feature, 'schema')
  for (const edit of [
    db => db.exec("UPDATE _prisma_migrations SET checksum = '0' WHERE migration_name = '20261007000100_landing_inquiries'"),
    db => db.exec("UPDATE _prisma_migrations SET finished_at = NULL WHERE migration_name = '20261007000100_landing_inquiries'"),
    db => db.exec("DELETE FROM _prisma_migrations WHERE migration_name = '20261007000100_landing_inquiries'"),
    db => db.exec("INSERT INTO _prisma_migrations SELECT 'duplicate', migration_name, checksum, finished_at, rolled_back_at FROM _prisma_migrations LIMIT 1"),
  ]) rejects(database(feature, edit), bridge, feature, 'migration_ledger')
  rejects(database(feature, db => {
    db.pragma('foreign_keys = OFF')
    db.exec("INSERT INTO LandingReceipt (id, inquiryId) VALUES ('synthetic-orphan', 'missing')")
  }), bridge, feature, 'integrity')
  // The policy is exactly the existing contract plus two tables and two indexes.
  const baseNames = new Set(original.schema.map(s => s.name))
  assert.deepEqual(feature.schema.filter(s => baseNames.has(s.name)), original.schema)
  assert.deepEqual(feature.schema.filter(s => !baseNames.has(s.name)).map(s => s.name).sort(),
    ['LandingReceipt','LandingReceipt_inquiryId_key','LandingThrottle','LandingThrottle_windowStart_idx'])
  assert.deepEqual(feature.migrations.slice(0,-1), original.migrations)
  assert.equal(feature.migrations.at(-1).name, policy.id)
  const db = new Database(expandedDb)
  try {
    db.prepare('UPDATE Customer SET name = ? WHERE id = ?').run('Synthetic old-version write', 'synthetic-existing')
    assert.equal(db.prepare('SELECT name FROM Customer WHERE id = ?').get('synthetic-existing').name, 'Synthetic old-version write')
  } finally { db.close() }
  accepts(expandedDb, bridge, feature, expandedContract)
  console.log('PASS: pinned expansion, bridge recovery and rollback, unprepared runtime rejection, schema/ledger/integrity tamper rejection, read-only checks, existing-table write')
} finally { rmSync(directory, { recursive:true, force:true }) }
