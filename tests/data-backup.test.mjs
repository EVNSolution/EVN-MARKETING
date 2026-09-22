import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, symlink, writeFile, chmod } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createManifest } from '../scripts/schema-check.mjs'
import { snapshot, verify, restore } from '../scripts/data-backup.mjs'
import { recordSyntheticMigrations } from './schema-fixture.mjs'

const Database = createRequire(import.meta.url)('better-sqlite3')
const root = await realpath(await mkdtemp(path.join(tmpdir(), 'marketing-backup-test-')))
const source = path.join(root, 'source'), bundle = path.join(root, 'bundle'), target = path.join(root, 'restored')
const manifest = createManifest(process.cwd(), 'a'.repeat(40))
let db
try {
  await mkdir(source); await mkdir(target)
  await mkdir(path.join(source, 'uploads/customers/synthetic'), { recursive: true })
  await writeFile(path.join(source, 'uploads/customers/synthetic/doc.pdf'), '%PDF synthetic')
  db = new Database(path.join(source, 'marketing.db'))
  for (const migration of manifest.migrations) db.exec(await readFile(`prisma/migrations/${migration.name}/migration.sql`, 'utf8'))
  recordSyntheticMigrations(db, process.cwd())
  db.pragma('journal_mode = WAL'); db.pragma('wal_autocheckpoint = 0')
  db.prepare('INSERT INTO User(id,name,email,password,updatedAt) VALUES(?,?,?,?,?)').run('synthetic-user','Synthetic','synthetic@example.invalid','synthetic-hash','2026-09-23')
  db.prepare('INSERT INTO Customer(id,name,documentsJson,updatedAt) VALUES(?,?,?,?)').run('synthetic','Synthetic',JSON.stringify([{path:'/api/uploads/customers/synthetic/doc.pdf',size:14}]),'2026-09-23')
  db.prepare('INSERT INTO Inquiry(id,source,companyScopeId,homepageScopeId,sourceId,inquiryDate,inquiryTime,phone,lastSeenAt,warpCustomerId,warpActivityId,warpDeliveredAt) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run('synthetic-inquiry','synthetic','company','homepage','source-id','2026-09-23','00:00','synthetic','2026-09-23','customer','receipt','2026-09-23')
  // Keep the connection open so committed data remains in WAL, not only the main file.
  const result = await snapshot(source, bundle, manifest)
  assert.equal(result.rows.Inquiry, 1); assert.equal(result.rows.User, 1); assert.equal(result.files, 1)
  assert.deepEqual(await verify(bundle, result.summarySha256, manifest), result)
  const summary = await readFile(path.join(bundle,'backup-summary.json'),'utf8')
  for (const privateValue of ['synthetic@example.invalid','synthetic-hash','source-id','doc.pdf']) assert.ok(!summary.includes(privateValue))
  assert.equal((await readdir(bundle)).some(name => /-(wal|shm)$/.test(name)), false)
  db.prepare('UPDATE Customer SET name=?').run('Latest customer')
  const restored = await restore(bundle, target, result.summarySha256, manifest)
  assert.ok(restored.restoreSeconds >= 0)
  const copy = new Database(path.join(target,'marketing.db'),{readonly:true})
  assert.equal(copy.prepare('SELECT name FROM Customer').get().name,'Synthetic')
  assert.equal(copy.prepare('SELECT warpActivityId FROM Inquiry').get().warpActivityId,'receipt')
  assert.equal(copy.prepare('SELECT password FROM User').get().password,'synthetic-hash')
  copy.close()
  assert.equal(db.prepare('SELECT name FROM Customer').get().name,'Latest customer')
  assert.equal(await readFile(path.join(target,'uploads/customers/synthetic/doc.pdf'),'utf8'),'%PDF synthetic')
  await assert.rejects(restore(bundle,target,result.summarySha256,manifest))
  await assert.rejects(snapshot(source,bundle,manifest))
  await assert.rejects(verify(bundle,'0'.repeat(64),manifest))
  await assert.rejects(verify(bundle,result.summarySha256,{...manifest,revision:'b'.repeat(40)}))
  await writeFile(path.join(bundle,'uploads/customers/synthetic/doc.pdf'),'corrupt')
  await assert.rejects(verify(bundle,result.summarySha256,manifest))
  await writeFile(path.join(bundle,'uploads/customers/synthetic/doc.pdf'),'%PDF synthetic')
  const original = await readFile(path.join(bundle,'inventory.json'))
  await writeFile(path.join(bundle,'inventory.json'),'{}')
  await assert.rejects(verify(bundle,result.summarySha256,manifest))
  await writeFile(path.join(bundle,'inventory.json'),original)
  await writeFile(path.join(bundle,'marketing.db-wal'),'unrecorded WAL')
  await assert.rejects(verify(bundle,result.summarySha256,manifest))
  await rm(path.join(bundle,'marketing.db-wal'))
  await symlink('/etc/passwd',path.join(source,'uploads/escaped'))
  await assert.rejects(snapshot(source,path.join(root,'escaped'),manifest))
  await rm(path.join(source,'uploads/escaped'))
  await rm(path.join(source,'uploads/customers/synthetic/doc.pdf'))
  await assert.rejects(snapshot(source,path.join(root,'missing'),manifest))
  await writeFile(path.join(source,'uploads/customers/synthetic/doc.pdf'),'%PDF synthetic')
  db.prepare('UPDATE Customer SET documentsJson=?').run(JSON.stringify([{path:'/api/uploads/customers/another/doc.pdf'}]))
  await assert.rejects(snapshot(source,path.join(root,'foreign'),manifest))
  db.prepare('UPDATE Customer SET documentsJson=NULL').run()
  db.prepare('INSERT INTO InquirySyncState(id,source,companyScopeId,homepageScopeId,workerOwner,updatedAt) VALUES(?,?,?,?,?,?)').run('state','s','c','h','busy','2026-09-23')
  await assert.rejects(snapshot(source,path.join(root,'busy'),manifest))
  console.log('offline backup: WAL snapshot, exact rows/receipts/uploads, latest source preservation, non-overwrite, corruption/path/reference/lease rejection passed')
} finally {
  db?.close()
  await chmod(root,0o700)
  await rm(root,{recursive:true,force:true})
}
