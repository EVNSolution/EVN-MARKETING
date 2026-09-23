import { createHash } from 'node:crypto'
import { lstatSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const Database = require('better-sqlite3')
const hash = value => createHash('sha256').update(value).digest('hex')
const fail = reason => { throw new Error(reason) }
const reasons = new Set(['arguments', 'manifest', 'schema_change_requires_review', 'database_path', 'schema', 'migration_ledger', 'integrity'])

function schema(db) {
  // Exact DDL is deliberately conservative: even equivalent rebuilds need review.
  return db.prepare("SELECT type, name, tbl_name, sql FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*' AND name != '_prisma_migrations' ORDER BY type, name").all()
}

export function createManifest(root, revision) {
  if (!/^[0-9a-f]{40}$/.test(revision)) fail('manifest')
  const directory = path.join(root, 'prisma/migrations')
  const migrations = readdirSync(directory, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name).sort()
  if (!migrations.length || migrations.some(name => !/^\d{14}_[a-z0-9_]+$/.test(name))) fail('manifest')
  const db = new Database(':memory:')
  try {
    const entries = migrations.map(name => {
      const sql = readFileSync(path.join(directory, name, 'migration.sql'))
      db.exec(sql.toString('utf8'))
      return { name, checksum: hash(sql) }
    })
    return { format: 1, revision, prismaSchemaSha256: hash(readFileSync(path.join(root, 'prisma/schema.prisma'))), migrations: entries, schema: schema(db) }
  } finally { db.close() }
}

function validateManifest(manifest) {
  if (manifest?.format !== 1 || !/^[0-9a-f]{40}$/.test(manifest.revision)
    || !/^[0-9a-f]{64}$/.test(manifest.prismaSchemaSha256)
    || !Array.isArray(manifest.migrations) || !manifest.migrations.length
    || manifest.migrations.some(entry => !/^\d{14}_[a-z0-9_]+$/.test(entry.name) || !/^[0-9a-f]{64}$/.test(entry.checksum))
    || new Set(manifest.migrations.map(entry => entry.name)).size !== manifest.migrations.length
    || !Array.isArray(manifest.schema) || !manifest.schema.length) fail('manifest')
}

export function checkSchema(database, current, previous) {
  validateManifest(current)
  validateManifest(previous)
  // No migration is performed by this tool. Changed schemas require the separate
  // expand/migration rehearsal before they can enter the ordinary release path.
  for (const field of ['prismaSchemaSha256', 'migrations', 'schema']) {
    if (JSON.stringify(current[field]) !== JSON.stringify(previous[field])) fail('schema_change_requires_review')
  }
  if (!path.isAbsolute(database) || path.normalize(database) !== database
    || !lstatSync(database).isFile() || realpathSync(database) !== database) fail('database_path')
  const db = new Database(database, { readonly: true, fileMustExist: true, timeout: 1000 })
  try {
    db.pragma('query_only = ON')
    // One read snapshot prevents the ledger and schema being observed at different times.
    db.exec('BEGIN')
    if (JSON.stringify(schema(db)) !== JSON.stringify(current.schema)) fail('schema')
    const ledgerExists = db.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = '_prisma_migrations'").get()
    if (!ledgerExists) fail('migration_ledger')
    const ledger = db.prepare('SELECT migration_name, checksum, finished_at, rolled_back_at FROM _prisma_migrations ORDER BY migration_name').all()
      .filter(row => row.rolled_back_at === null)
    if (ledger.some(row => row.finished_at === null)
      || JSON.stringify(ledger.map(row => ({ name: row.migration_name, checksum: row.checksum }))) !== JSON.stringify(current.migrations)) fail('migration_ledger')
    if (JSON.stringify(db.pragma('integrity_check')) !== JSON.stringify([{ integrity_check: 'ok' }])
      || db.pragma('foreign_key_check').length) fail('integrity')
    return { ok: true, policy: 'unchanged-schema', current: current.revision, previous: previous.revision }
  } finally { db.close() }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [mode, ...args] = process.argv.slice(2)
    if (mode === 'manifest' && args.length === 3) {
      const [root, revision, output] = args
      writeFileSync(output, JSON.stringify(createManifest(root, revision)) + '\n', { flag: 'wx', mode: 0o600 })
      console.log(JSON.stringify({ ok: true, revision }))
    } else if (mode === 'check' && args.length === 2) {
      const url = process.env.DATABASE_URL ?? ''
      if (!url.startsWith('file:')) fail('database_path')
      console.log(JSON.stringify(checkSchema(url.slice(5), ...args.map(file => JSON.parse(readFileSync(file, 'utf8'))))))
    } else fail('arguments')
  } catch (error) {
    console.log(JSON.stringify({ ok: false, reason: reasons.has(error.message) ? error.message : 'schema_check_failed' }))
    process.exitCode = 1
  }
}
