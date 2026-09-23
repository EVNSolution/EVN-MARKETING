import { createHash } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'

// Synthetic databases only. Never use this to baseline or repair a real ledger.
export function recordSyntheticMigrations(db, root) {
  db.exec('CREATE TABLE _prisma_migrations (id TEXT PRIMARY KEY, migration_name TEXT NOT NULL, checksum TEXT NOT NULL, started_at DATETIME NOT NULL, finished_at DATETIME, rolled_back_at DATETIME, logs TEXT, applied_steps_count INTEGER NOT NULL DEFAULT 0)')
  const directory = path.join(root, 'prisma/migrations')
  for (const name of readdirSync(directory).filter(name => /^\d{14}_/.test(name)).sort()) {
    const checksum = createHash('sha256').update(readFileSync(path.join(directory, name, 'migration.sql'))).digest('hex')
    db.prepare('INSERT INTO _prisma_migrations (id, migration_name, checksum, started_at, finished_at, applied_steps_count) VALUES (?, ?, ?, ?, ?, 1)')
      .run(name, name, checksum, '2026-09-22T00:00:00Z', '2026-09-22T00:00:00Z')
  }
}
