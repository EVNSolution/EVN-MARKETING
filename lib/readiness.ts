import { constants } from 'node:fs'
import { access, lstat, open, readFile, realpath, unlink } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3'
import { Prisma } from '@/app/generated/prisma/client'

const schema = {
  Team: Prisma.TeamScalarFieldEnum,
  User: Prisma.UserScalarFieldEnum,
  Customer: Prisma.CustomerScalarFieldEnum,
  CustomerActivity: Prisma.CustomerActivityScalarFieldEnum,
  Inquiry: Prisma.InquiryScalarFieldEnum,
  InquirySyncRun: Prisma.InquirySyncRunScalarFieldEnum,
  InquirySyncState: Prisma.InquirySyncStateScalarFieldEnum,
}
const uniqueIndexes = {
  Team: ['Team_name_key', 'name'],
  User: ['User_email_key', 'email'],
  Inquiry: ['Inquiry_source_companyScopeId_homepageScopeId_sourceId_key', 'source,companyScopeId,homepageScopeId,sourceId'],
  InquirySyncState: ['InquirySyncState_source_companyScopeId_homepageScopeId_key', 'source,companyScopeId,homepageScopeId'],
}

async function writableDirectory(directory: string, device: number) {
  const stat = await lstat(directory)
  if (!stat.isDirectory() || stat.dev !== device || await realpath(directory) !== directory) throw new Error('invalid_directory')
  const probe = path.join(directory, `.readiness-${randomUUID()}`)
  const file = await open(probe, 'wx', 0o600)
  try {
    await file.writeFile('probe')
    await file.sync()
  } finally {
    try { await file.close() } finally { await unlink(probe) }
  }
}

export async function readReadiness(env: NodeJS.ProcessEnv = process.env) {
  try {
    const revision = env.MARKETING_REVISION ?? ''
    const imageDigest = env.MARKETING_IMAGE_DIGEST ?? ''
    const volumeId = env.MARKETING_VOLUME_ID ?? ''
    if (!/^[0-9a-f]{40}$/.test(revision) || !/^sha256:[0-9a-f]{64}$/.test(imageDigest)
      || !/^[A-Za-z0-9_-]{1,64}$/.test(volumeId)) return { ok: false } as const

    const url = env.DATABASE_URL ?? ''
    const database = url.startsWith('file:') ? url.slice(5) : ''
    const uploads = env.UPLOADS_DIR ?? ''
    if (!path.isAbsolute(database) || !path.isAbsolute(uploads)
      || path.normalize(database) !== database || path.normalize(uploads) !== uploads
      || path.dirname(database) !== path.dirname(uploads)) return { ok: false } as const
    const directory = path.dirname(database)
    const dbStat = await lstat(database)
    if (!dbStat.isFile() || await realpath(database) !== database) return { ok: false } as const
    await access(database, constants.R_OK | constants.W_OK)
    for (const suffix of ['-wal', '-shm']) {
      try {
        if (!(await lstat(database + suffix)).isFile()) return { ok: false } as const
        await access(database + suffix, constants.R_OK | constants.W_OK)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
    const marker = path.join(directory, '.marketing-volume-id')
    const markerStat = await lstat(marker)
    if (!markerStat.isFile() || markerStat.size > 128
      || (await readFile(marker, 'utf8')).trim() !== volumeId) return { ok: false } as const

    // Read only, and never initialize a missing DB or change its journal/schema.
    const connection = await new PrismaBetterSqlite3({ url, readonly: true, fileMustExist: true, timeout: 1_000 }).connect()
    const query = (sql: string) => connection.queryRaw({ sql, args: [], argTypes: [] })
    try {
      if ((await query('PRAGMA journal_mode')).rows[0]?.[0] !== 'wal') return { ok: false } as const
      const tables = new Set((await query("SELECT name FROM sqlite_schema WHERE type = 'table'")).rows.map(row => row[0]))
      for (const [table, columns] of Object.entries(schema)) {
        if (!tables.has(table)) return { ok: false } as const
        const fields = await query(`SELECT name, pk FROM pragma_table_info('${table}')`)
        const present = new Set(fields.rows.map(row => row[0]))
        if (!Object.values(columns).every(column => present.has(column))
          || !fields.rows.some(row => row[0] === 'id' && Number(row[1]) === 1)) return { ok: false } as const
      }
      for (const [table, [index, columns]] of Object.entries(uniqueIndexes)) {
        const found = await query(`SELECT name FROM pragma_index_list('${table}') WHERE name = '${index}' AND "unique" = 1 AND partial = 0`)
        const fields = await query(`SELECT name FROM pragma_index_info('${index}') ORDER BY seqno`)
        if (found.rows.length !== 1 || fields.rows.map(row => row[0]).join(',') !== columns) return { ok: false } as const
      }
    } finally {
      await connection.dispose()
    }
    await writableDirectory(directory, dbStat.dev)
    await writableDirectory(uploads, dbStat.dev)
    return { ok: true, revision, imageDigest } as const
  } catch {
    // Public probes reveal no paths, customer values, credentials or raw errors.
    return { ok: false } as const
  }
}
