import assert from 'node:assert/strict'
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3'
import { readReadiness } from '@/lib/readiness'
import { GET } from '@/app/api/readyz/route'

async function main() {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'marketing-readiness-')))
  const database = path.join(directory, 'marketing.db')
  const uploads = path.join(directory, 'uploads')
  const marker = path.join(directory, '.marketing-volume-id')
  const env: NodeJS.ProcessEnv = {
    NODE_ENV: 'production',
    DATABASE_URL: `file:${database}`, UPLOADS_DIR: uploads,
    MARKETING_REVISION: 'a'.repeat(40), MARKETING_IMAGE_DIGEST: `sha256:${'b'.repeat(64)}`,
    MARKETING_VOLUME_ID: 'synthetic-volume',
  }
  const expected = { ok: true, revision: env.MARKETING_REVISION, imageDigest: env.MARKETING_IMAGE_DIGEST }
  const original = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]))
  const execute = async (sql: string) => {
    const connection = await new PrismaBetterSqlite3({ url: env.DATABASE_URL!, fileMustExist: true }).connect()
    try { await connection.executeScript(sql) } finally { await connection.dispose() }
  }
  try {
    await mkdir(uploads)
    await writeFile(marker, `${env.MARKETING_VOLUME_ID}\n`)
    assert.deepEqual(await readReadiness(env), { ok: false })
    await assert.rejects(lstat(database), { code: 'ENOENT' }, 'probe must not create an empty database')
    const connection = await new PrismaBetterSqlite3({ url: env.DATABASE_URL! }).connect()
    try {
      for (const migration of ['20260915000100_baseline', '20260915000200_inquiry_sync', '20260915000300_warp_delivery']) {
        await connection.executeScript(await readFile(`prisma/migrations/${migration}/migration.sql`, 'utf8'))
      }
      await connection.executeScript('PRAGMA journal_mode = WAL')
    } finally { await connection.dispose() }

    const before = await readFile(database)
    assert.deepEqual(await readReadiness(env), expected)
    assert.deepEqual(await readFile(database), before, 'readiness must not change the database')
    assert.ok((await readdir(directory)).every(name => ['.marketing-volume-id', 'marketing.db', 'marketing.db-wal', 'marketing.db-shm', 'uploads'].includes(name)))
    assert.deepEqual(await readdir(uploads), [], 'all writable probes are removed')

    for (const bad of [
      { MARKETING_REVISION: undefined }, { MARKETING_REVISION: 'unsafe-secret-placeholder' },
      { MARKETING_IMAGE_DIGEST: '' }, { MARKETING_VOLUME_ID: 'wrong-volume' },
      { DATABASE_URL: 'file:relative.db' }, { DATABASE_URL: ':memory:' }, { UPLOADS_DIR: directory },
    ]) assert.deepEqual(await readReadiness({ ...env, ...bad }), { ok: false })
    await writeFile(marker, 'wrong marker with synthetic private information')
    assert.deepEqual(await readReadiness(env), { ok: false })
    await writeFile(marker, env.MARKETING_VOLUME_ID!)
    await chmod(uploads, 0o500)
    assert.deepEqual(await readReadiness(env), { ok: false }, 'read-only upload directory is unhealthy')
    await chmod(uploads, 0o700)
    await chmod(database, 0o400)
    assert.deepEqual(await readReadiness(env), { ok: false }, 'read-only database is unhealthy')
    await chmod(database, 0o600)
    await rename(uploads, uploads + '-real')
    await symlink(uploads + '-real', uploads)
    assert.deepEqual(await readReadiness(env), { ok: false }, 'upload symlinks fail closed')
    await rm(uploads)
    await rename(uploads + '-real', uploads)

    await execute('PRAGMA journal_mode = DELETE')
    assert.deepEqual(await readReadiness(env), { ok: false }, 'probe must not enable WAL itself')
    await execute('PRAGMA journal_mode = WAL')
    await execute('ALTER TABLE Customer RENAME COLUMN memo TO legacyMemo')
    assert.deepEqual(await readReadiness(env), { ok: false }, 'missing required column fails')
    await execute('ALTER TABLE Customer RENAME COLUMN legacyMemo TO memo')
    await execute('DROP INDEX Inquiry_source_companyScopeId_homepageScopeId_sourceId_key')
    assert.deepEqual(await readReadiness(env), { ok: false }, 'deduplication index is required')
    await execute('CREATE UNIQUE INDEX Inquiry_source_companyScopeId_homepageScopeId_sourceId_key ON Inquiry(source, companyScopeId, homepageScopeId, sourceId)')
    assert.deepEqual(await readReadiness(env), expected)

    Object.assign(process.env, env)
    const ready = await GET()
    assert.equal(ready.status, 200)
    assert.equal(ready.headers.get('cache-control'), 'no-store')
    assert.deepEqual(await ready.json(), expected)
    process.env.MARKETING_IMAGE_DIGEST = 'synthetic-private-invalid-value'
    const failed = await GET()
    assert.equal(failed.status, 503)
    assert.deepEqual(await failed.json(), { ok: false }, 'no paths, configuration or failure details in public output')
    console.log('readiness: identity, existing schema/WAL, volume, writable paths, no DB writes and safe HTTP response passed')
  } finally {
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    await chmod(uploads, 0o700).catch(() => {})
    await rm(directory, { recursive: true, force: true })
  }
}

main().catch(error => { console.error(error); process.exitCode = 1 })
