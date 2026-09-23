import path from 'node:path'
import { lstat, realpath } from 'node:fs/promises'
import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3'
import { INQUIRY_SCOPE_ID, WORKER_LEASE_MS } from './inquiry-sync'

const OWNER = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

export function configuredWorkerOwner(env: NodeJS.ProcessEnv = process.env) {
  const owner = env.MARKETING_WORKER_OWNER
  if (!owner && env.NODE_ENV !== 'production') return undefined
  if (!owner || !OWNER.test(owner)) throw new Error('invalid_worker_owner')
  return owner
}

export async function readWorkerHealth(env: NodeJS.ProcessEnv = process.env, now = new Date()) {
  try {
    const owner = configuredWorkerOwner({ ...env, NODE_ENV: 'production' })
    const revision = env.MARKETING_REVISION ?? ''
    const imageDigest = env.MARKETING_IMAGE_DIGEST ?? ''
    if (!/^[0-9a-f]{40}$/.test(revision) || !/^sha256:[0-9a-f]{64}$/.test(imageDigest)) return { ok: false, reason: 'configuration' } as const
    const url = env.DATABASE_URL ?? ''
    const database = url.startsWith('file:') ? url.slice(5) : ''
    if (!path.isAbsolute(database) || path.normalize(database) !== database
      || !(await lstat(database)).isFile() || await realpath(database) !== database) return { ok: false, reason: 'database' } as const
    const connection = await new PrismaBetterSqlite3({ url, readonly: true, fileMustExist: true, timeout: 1_000 }).connect()
    try {
      const result = await connection.queryRaw({
        sql: 'SELECT workerOwner, workerHeartbeatAt, workerLeaseExpiresAt, status, lastSuccessfulAt FROM InquirySyncState WHERE id = ?',
        args: [INQUIRY_SCOPE_ID], argTypes: [{ scalarType: 'string', dbType: 'TEXT', arity: 'scalar' }],
      })
      const row = result.rows[0]
      if (!row || row[0] !== owner) return { ok: false, reason: 'owner' } as const
      const heartbeat = timestamp(row[1])
      const expires = timestamp(row[2])
      const age = now.getTime() - heartbeat
      if (!Number.isFinite(age) || age < -5_000 || age >= WORKER_LEASE_MS || !(expires > now.getTime())) return { ok: false, reason: 'lease' } as const
      if (!['ready', 'running', 'success'].includes(String(row[3]))) return { ok: false, reason: 'source' } as const
      const lastSuccess = timestamp(row[4])
      return { ok: true, revision, imageDigest, heartbeatAt: new Date(heartbeat).toISOString(), lastSuccessfulAt: Number.isFinite(lastSuccess) ? new Date(lastSuccess).toISOString() : null } as const
    } finally {
      await connection.dispose()
    }
  } catch {
    return { ok: false, reason: 'unavailable' } as const
  }
}

function timestamp(value: unknown) {
  return typeof value === 'string' || typeof value === 'number' ? new Date(value).getTime() : NaN
}
