import { createRequire } from 'node:module'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { recordSyntheticMigrations } from './schema-fixture.mjs'

const require = createRequire('/app/package.json')
const Database = require('better-sqlite3')
const bcrypt = createRequire('/src/package.json')('bcryptjs')
const db = new Database('/data/marketing.db')
for (const migration of ['20260915000100_baseline', '20260915000200_inquiry_sync', '20260915000300_warp_delivery', '20261007000100_landing_inquiries']) {
  db.exec(readFileSync(`/src/prisma/migrations/${migration}/migration.sql`, 'utf8'))
}
recordSyntheticMigrations(db, '/src')
db.pragma('journal_mode = WAL')
db.prepare('INSERT INTO User (id, name, email, password, role, updatedAt) VALUES (?, ?, ?, ?, ?, ?)')
  .run('synthetic-user', 'Synthetic user', 'synthetic@example.invalid', bcrypt.hashSync('synthetic-compat-only', 4), 'admin', new Date().toISOString())
for (const id of ['synthetic-edit', 'synthetic-quota', 'synthetic-parallel']) {
  db.prepare('INSERT INTO Customer (id, name, customerSegment, companyName, updatedAt) VALUES (?, ?, ?, ?, ?)')
    .run(id, 'Synthetic customer', 'B2B', 'Synthetic company', new Date().toISOString())
}
db.prepare('INSERT INTO Team(id,name) VALUES(?,?)').run('synthetic-team', 'Synthetic team')
db.prepare('UPDATE User SET teamId=?').run('synthetic-team')
const timestamp = '2026-09-23T00:00:00.000Z'
for (let index = 1; index <= 2; index++) {
  db.prepare('INSERT INTO Inquiry(id,source,companyScopeId,homepageScopeId,sourceId,inquiryDate,inquiryTime,phone,lastSeenAt,warpCustomerId,warpActivityId,warpDeliveredAt) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)')
    .run(`synthetic-inquiry-${index}`, 'synthetic', 'company', 'homepage', `00000000-0000-4000-8000-00000000000${index}`,
      '2026-09-23', '09:00', '010-0000-0000', timestamp, index === 1 ? 'synthetic-customer' : null,
      index === 1 ? 'synthetic-receipt' : null, index === 1 ? timestamp : null)
}
db.prepare('INSERT INTO InquirySyncRun(id,source,companyScopeId,homepageScopeId,trigger,status,rangeStart,rangeEnd,completedAt,readCount,createdCount,pagesRead) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)')
  .run('synthetic-run', 'synthetic', 'company', 'homepage', 'schedule', 'success', '2026-09-22', '2026-09-23', timestamp, 2, 2, 1)
db.prepare('INSERT INTO InquirySyncState(id,source,companyScopeId,homepageScopeId,lastSuccessfulAt,lastRunId,nextRunAt,updatedAt) VALUES(?,?,?,?,?,?,?,?)')
  .run('synthetic-state', 'synthetic', 'company', 'homepage', timestamp, 'synthetic-run', '2026-09-23T01:00:00.000Z', timestamp)
db.close()
mkdirSync('/data/uploads/customers/synthetic-quota', { recursive: true })
for (let index = 0; index < 5; index++) {
  const buffer = Buffer.alloc((index === 4 ? 4 : 10) * 1024 * 1024)
  buffer.write('%PDF-synthetic')
  writeFileSync(`/data/uploads/customers/synthetic-quota/existing-${index}.pdf`, buffer)
}
writeFileSync('/data/.marketing-volume-id', 'synthetic-compat-volume\n')
console.log('isolated compatibility fixture created')
