// Consistent DB + uploads operations. Stop worker leases; reject concurrent data changes.
import { createHash } from 'node:crypto'
import { constants, createReadStream } from 'node:fs'
import { chmod, copyFile, lstat, mkdir, open, readFile, readdir, realpath } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkSchema } from './schema-check.mjs'

const Database = createRequire(import.meta.url)('better-sqlite3')
const fail = () => { throw new Error('backup_validation_failed') }
const hash = value => createHash('sha256').update(value).digest('hex')
const json = value => JSON.stringify(value, (_, v) => typeof v === 'bigint' ? { integer: String(v) } : v)
const same = (a, b) => { if (json(a) !== json(b)) fail() }
const quote = name => '"' + name.replaceAll('"', '""') + '"'

async function safe(file, directory = false) {
  if (!path.isAbsolute(file) || path.normalize(file) !== file || await realpath(file) !== file) fail()
  const info = await lstat(file)
  if (directory ? !info.isDirectory() : !info.isFile() || info.nlink !== 1) fail()
  return info
}

async function digest(file) {
  await safe(file)
  const sum = createHash('sha256')
  for await (const chunk of createReadStream(file)) sum.update(chunk)
  return sum.digest('hex')
}

async function durable(file, value) {
  const fd = await open(file, 'wx', 0o600)
  try { await fd.writeFile(value); await fd.sync() } finally { await fd.close() }
}

async function syncDirectory(directory, recursive = false) {
  if (recursive) for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) await syncDirectory(path.join(directory, entry.name), true)
  }
  const fd = await open(directory, 'r')
  try { await fd.sync() } finally { await fd.close() }
}

async function inventory(directory, relative = '') {
  await safe(directory, true)
  const entries = []
  for (const name of (await readdir(directory)).sort()) {
    if (name.includes('\\') || name.includes('\0')) fail()
    const file = path.join(directory, name), info = await lstat(file)
    const item = relative ? relative + '/' + name : name
    if (info.isDirectory() && !info.isSymbolicLink()) entries.push(...await inventory(file, item))
    else {
      await safe(file)
      entries.push({ path: item, bytes: info.size, sha256: await digest(file) })
    }
  }
  return entries
}

function databaseState(file, manifest, files) {
  checkSchema(file, manifest, manifest)
  const db = new Database(file, { readonly: true, fileMustExist: true })
  db.defaultSafeIntegers()
  try {
    db.exec('BEGIN')
    const leases = db.prepare('SELECT workerOwner,lockOwner FROM InquirySyncState').all()
    if (leases.some(row => row.workerOwner || row.lockOwner)) fail()
    const rows = {}, hashes = {}
    for (const { name } of db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT GLOB 'sqlite_*' ORDER BY name").all()) {
      const columns = db.prepare(`PRAGMA table_info(${quote(name)})`).all().map(c => quote(c.name))
      const sum = createHash('sha256')
      let count = 0
      for (const row of db.prepare(`SELECT * FROM ${quote(name)} ORDER BY ${columns.join(',')}`).iterate()) {
        sum.update(json(row) + '\n'); count++
      }
      rows[name] = count; hashes[name] = sum.digest('hex')
    }
    const available = new Map(files.map(file => [file.path, file]))
    const list = value => {
      const result = value === null ? [] : JSON.parse(value)
      if (!Array.isArray(result)) fail()
      return result
    }
    for (const row of db.prepare('SELECT id,mainContactCardUrl,contactsJson,documentsJson FROM Customer').iterate()) {
      if (!/^[A-Za-z0-9_-]+$/.test(row.id)) fail()
      const docs = list(row.documentsJson)
      const refs = [row.mainContactCardUrl, ...list(row.contactsJson).map(c => c.cardUrl), ...docs.map(d => d.path)]
      for (const url of refs.filter(v => v !== null && v !== undefined && v !== '')) {
        if (typeof url !== 'string' || !url.startsWith(`/api/uploads/customers/${row.id}/`)) fail()
        const relative = url.slice('/api/uploads/'.length)
        if (!available.has(relative)) fail()
        const doc = docs.find(d => d.path === url)
        if (doc?.size !== undefined && doc.size !== available.get(relative).bytes) fail()
      }
    }
    const delivery = db.prepare('SELECT count(*) total, sum(warpDeliveredAt IS NOT NULL) delivered, sum(warpDeliveredAt IS NULL AND warpError IS NOT NULL) failed FROM Inquiry').get()
    return { rows, hashes, delivery: Object.fromEntries(Object.entries(delivery).map(([k,v]) => [k, Number(v ?? 0)])) }
  } finally { db.close() }
}

async function inspect(directory, manifest) {
  await safe(directory, true)
  const files = await inventory(path.join(directory, 'uploads'))
  const database = path.join(directory, 'marketing.db')
  await safe(database)
  return { files, ...databaseState(database, manifest, files) }
}

async function copyUploads(source, target, files) {
  await mkdir(target, { mode: 0o700 })
  for (const file of files) {
    const destination = path.join(target, file.path)
    await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 })
    await copyFile(path.join(source, file.path), destination, constants.COPYFILE_EXCL)
    await chmod(destination, 0o600)
    const fd = await open(destination, 'r')
    try { await fd.sync() } finally { await fd.close() }
    await syncDirectory(path.dirname(destination))
  }
  await syncDirectory(target, true)
}

export async function snapshot(source, destination, manifest) {
  await safe(source, true)
  if (!path.isAbsolute(destination) || path.normalize(destination) !== destination) fail()
  if (destination === source || (destination.startsWith(source + '/') && !destination.startsWith(source + '/backups/'))) fail()
  await safe(path.dirname(destination), true)
  const before = await inspect(source, manifest)
  await mkdir(destination, { mode: 0o700 }) // Never overwrite even an incomplete backup.
  const db = new Database(path.join(source, 'marketing.db'), { readonly: true, fileMustExist: true })
  try { await db.backup(path.join(destination, 'marketing.db')) } finally { db.close() }
  const offline = new Database(path.join(destination, 'marketing.db'), { fileMustExist: true })
  try { offline.pragma('journal_mode = DELETE') } finally { offline.close() }
  await chmod(path.join(destination, 'marketing.db'), 0o600)
  const fd = await open(path.join(destination, 'marketing.db'), 'r')
  try { await fd.sync() } finally { await fd.close() }
  await copyUploads(path.join(source, 'uploads'), path.join(destination, 'uploads'), before.files)
  same(before, await inspect(destination, manifest))
  same(before, await inspect(source, manifest)) // Detect unexpected writers during the copy.
  await durable(path.join(destination, 'inventory.json'), json(before) + '\n')
  const summary = {
    format: 1, revision: manifest.revision, createdAt: new Date().toISOString(),
    databaseSha256: await digest(path.join(destination, 'marketing.db')),
    databaseBytes: (await lstat(path.join(destination, 'marketing.db'))).size,
    inventorySha256: await digest(path.join(destination, 'inventory.json')),
    files: before.files.length, uploadBytes: before.files.reduce((n, f) => n + f.bytes, 0),
    rows: before.rows, delivery: before.delivery, migrations: manifest.migrations,
  }
  // Completion marker written last; missing/partial markers cannot be restored.
  const text = json(summary) + '\n'
  await durable(path.join(destination, 'backup-summary.json'), text)
  await syncDirectory(destination)
  await syncDirectory(path.dirname(destination))
  return { ok: true, summarySha256: hash(text), files: summary.files, rows: summary.rows }
}

export async function verify(bundle, expected, manifest) {
  if (!/^[a-f0-9]{64}$/.test(expected)) fail()
  await safe(bundle, true)
  const summaryFile = path.join(bundle, 'backup-summary.json')
  if (await digest(summaryFile) !== expected) fail()
  const summary = JSON.parse(await readFile(summaryFile, 'utf8'))
  if (summary.format !== 1 || summary.revision !== manifest.revision) fail()
  same(summary.migrations, manifest.migrations)
  if (await digest(path.join(bundle, 'marketing.db')) !== summary.databaseSha256
    || (await lstat(path.join(bundle, 'marketing.db'))).size !== summary.databaseBytes
    || await digest(path.join(bundle, 'inventory.json')) !== summary.inventorySha256) fail()
  // A staged DB may never depend on an unrecorded WAL or accompanying files.
  same((await readdir(bundle)).sort(), ['backup-summary.json', 'inventory.json', 'marketing.db', 'uploads'])
  const expectedState = JSON.parse(await readFile(path.join(bundle, 'inventory.json'), 'utf8'))
  same(expectedState, await inspect(bundle, manifest))
  same(summary.rows, expectedState.rows); same(summary.delivery, expectedState.delivery)
  if (summary.files !== expectedState.files.length || summary.uploadBytes !== expectedState.files.reduce((n,f) => n+f.bytes,0)) fail()
  return { ok: true, summarySha256: expected, files: summary.files, rows: summary.rows }
}

export async function restore(bundle, destination, expected, manifest) {
  const began = performance.now()
  const result = await verify(bundle, expected, manifest)
  await safe(destination, true)
  if ((await readdir(destination)).length) fail()
  const files = JSON.parse(await readFile(path.join(bundle, 'inventory.json'), 'utf8')).files
  await copyFile(path.join(bundle, 'marketing.db'), path.join(destination, 'marketing.db'), constants.COPYFILE_EXCL)
  await chmod(path.join(destination, 'marketing.db'), 0o600)
  // The immutable bundle is standalone; the new runtime copy must satisfy readiness before app queries.
  const restored = new Database(path.join(destination, 'marketing.db'), { fileMustExist: true })
  try { if (restored.pragma('journal_mode = WAL', { simple: true }) !== 'wal') fail() } finally { restored.close() }
  const fd = await open(path.join(destination, 'marketing.db'), 'r')
  try { await fd.sync() } finally { await fd.close() }
  await copyUploads(path.join(bundle, 'uploads'), path.join(destination, 'uploads'), files)
  same(await inspect(bundle, manifest), await inspect(destination, manifest))
  await syncDirectory(destination)
  return { ...result, restoreSeconds: (performance.now() - began) / 1000 }
}

export async function audit(directory, manifest) {
  const value = await inspect(directory, manifest)
  return { ok: true, contentSha256: hash(json(value)), rows: value.rows, files: value.files.length }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [mode, ...args] = process.argv.slice(2)
    const manifest = JSON.parse(await readFile(new URL('./schema-manifest.json', import.meta.url), 'utf8'))
    let result
    if (mode === 'snapshot' && args.length === 2) result = await snapshot(...args, manifest)
    else if (mode === 'verify' && args.length === 2) result = await verify(...args, manifest)
    else if (mode === 'restore' && args.length === 3) result = await restore(...args, manifest)
    else if (mode === 'audit' && args.length === 1) result = await audit(args[0], manifest)
    else fail()
    console.log(JSON.stringify(result))
  } catch {
    console.error(JSON.stringify({ ok: false, reason: 'backup_validation_failed' }))
    process.exitCode = 1
  }
}
