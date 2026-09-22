import { createRequire } from 'node:module'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'

const require = createRequire('/app/package.json')
const Database = require('better-sqlite3')
const bcrypt = createRequire('/src/package.json')('bcryptjs')
const db = new Database('/data/marketing.db')
for (const migration of ['20260915000100_baseline', '20260915000200_inquiry_sync', '20260915000300_warp_delivery']) {
  db.exec(readFileSync(`/src/prisma/migrations/${migration}/migration.sql`, 'utf8'))
}
db.pragma('journal_mode = WAL')
db.prepare('INSERT INTO User (id, name, email, password, role, updatedAt) VALUES (?, ?, ?, ?, ?, ?)')
  .run('synthetic-user', 'Synthetic user', 'synthetic@example.invalid', bcrypt.hashSync('synthetic-compat-only', 4), 'admin', new Date().toISOString())
for (const id of ['synthetic-edit', 'synthetic-quota', 'synthetic-parallel']) {
  db.prepare('INSERT INTO Customer (id, name, customerSegment, companyName, updatedAt) VALUES (?, ?, ?, ?, ?)')
    .run(id, 'Synthetic customer', 'B2B', 'Synthetic company', new Date().toISOString())
}
db.close()
mkdirSync('/data/uploads/customers/synthetic-quota', { recursive: true })
for (let index = 0; index < 5; index++) {
  const buffer = Buffer.alloc((index === 4 ? 4 : 10) * 1024 * 1024)
  buffer.write('%PDF-synthetic')
  writeFileSync(`/data/uploads/customers/synthetic-quota/existing-${index}.pdf`, buffer)
}
writeFileSync('/data/.marketing-volume-id', 'synthetic-compat-volume\n')
console.log('isolated compatibility fixture created')
