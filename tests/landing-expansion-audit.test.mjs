import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expansionAudit, assertExpansionPreserved } from '../scripts/landing-expansion-audit.mjs'
import { landingSchemaPolicy as policy } from '../scripts/schema-compatibility.mjs'

const Database=createRequire(import.meta.url)('better-sqlite3')
const root=realpathSync(mkdtempSync(path.join(tmpdir(),'landing-expand-audit-')))
const file=path.join(root,'marketing.db'), upload=path.join(root,'uploads','synthetic.pdf')
mkdirSync(path.dirname(upload))
writeFileSync(upload,'%PDF-synthetic-preservation')
const db=new Database(file)
function add(entries) {
  for (const type of ['table','index']) for (const entry of entries.filter(e=>e.type===type)) db.exec(entry.sql)
}
function ledger(migration) {
  db.prepare('INSERT INTO _prisma_migrations VALUES (?,?,?,?,NULL)').run(migration.name,migration.name,migration.checksum,'2026-10-07')
}
try {
  add(policy.baseline.schema)
  // Synthetic fixtures only; real operations use Prisma migrate deploy exclusively.
  db.exec('CREATE TABLE _prisma_migrations (id TEXT PRIMARY KEY,migration_name TEXT NOT NULL,checksum TEXT NOT NULL,finished_at DATETIME,rolled_back_at DATETIME)')
  for (const m of policy.baseline.migrations) ledger(m)
  db.exec("INSERT INTO Customer (id,name,updatedAt) VALUES ('synthetic-existing','Synthetic existing','2026-10-07')")
  const bytes=readFileSync(file)
  const before=await expansionAudit(root,'baseline')
  assert.deepEqual(readFileSync(file),bytes,'baseline audit is read-only')
  await assert.rejects(()=>expansionAudit(root,'expanded'))
  const existing=new Set(policy.baseline.schema.map(e=>e.name))
  add(policy.expanded.schema.filter(e=>!existing.has(e.name)))
  ledger(policy.expanded.migrations.at(-1))
  const expandedBytes=readFileSync(file)
  const after=await expansionAudit(root,'expanded')
  assert.deepEqual(readFileSync(file),expandedBytes,'expanded audit is read-only')
  assert.equal(assertExpansionPreserved(before,after).existingDataPreserved,true)
  await assert.rejects(()=>expansionAudit(root,'baseline'))
  db.exec("UPDATE Customer SET name='Changed synthetic existing'")
  const changedCustomer=await expansionAudit(root,'expanded')
  assert.throws(()=>assertExpansionPreserved(before,changedCustomer),/landing_expansion_audit/)
  db.exec("UPDATE Customer SET name='Synthetic existing'")
  writeFileSync(upload,'%PDF-synthetic-corrupted')
  const changedFile=await expansionAudit(root,'expanded')
  assert.throws(()=>assertExpansionPreserved(before,changedFile),/landing_expansion_audit/)
  writeFileSync(upload,'%PDF-synthetic-preservation')
  db.exec("INSERT INTO LandingThrottle (id,windowStart,count) VALUES ('unexpected','2026-10-07',1)")
  const earlyIntake=await expansionAudit(root,'expanded')
  assert.throws(()=>assertExpansionPreserved(before,earlyIntake),/landing_expansion_audit/)
  db.exec('DELETE FROM LandingThrottle')
  db.exec("UPDATE _prisma_migrations SET finished_at='2026-10-08' WHERE migration_name='20260915000100_baseline'")
  const changedHistory=await expansionAudit(root,'expanded')
  assert.throws(()=>assertExpansionPreserved(before,changedHistory),/landing_expansion_audit/)
  db.exec("UPDATE _prisma_migrations SET finished_at='2026-10-07' WHERE migration_name='20260915000100_baseline'")
  db.exec('DROP INDEX LandingThrottle_windowStart_idx')
  await assert.rejects(()=>expansionAudit(root,'expanded'))
  console.log('PASS: read-only baseline/expanded evidence, data/upload/ledger changes rejected, early intake and partial schema rejected')
} finally {
  db.close()
  rmSync(root,{recursive:true,force:true})
}
