import assert from 'node:assert/strict'
import { createClient } from '@libsql/client'
import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3'
import { PrismaClient } from '@/app/generated/prisma/client'
import { claimWorker, releaseWorker, SyncError } from '@/lib/inquiry-sync'
import { dispatchPendingWarp } from './warp-phone-check-helper'
import { warpActivityId } from '@/lib/warp-delivery'

type Command = { action: 'claim' | 'dispatch' | 'release' | 'close'; at: number; pause?: boolean }

const [marketingUrl, warpUrl, owner] = process.argv.slice(2)
for (const url of [marketingUrl, warpUrl]) assert.ok(url?.startsWith('file:') && url.includes('evn-data-recovery-'))
assert.ok(owner)

const db = new PrismaClient({
  adapter: new PrismaBetterSqlite3({ url: marketingUrl, timeout: 5000 }, { timestampFormat: 'iso8601' }),
})
const env = { WARP_DELIVERY_ENABLED: 'true', WARP_MARKETING_API_KEY: 'synthetic-recovery-key-000000000000' }
globalThis.fetch = async () => { throw new Error('real network access is forbidden') }

function reply(value: object) { process.send!(value) }

async function send(_url: string | URL | Request, init?: RequestInit) {
  const payload = JSON.parse(String(init?.body)) as { sourceId: string }
  const activityId = warpActivityId(payload.sourceId)
  const warp = createClient({ url: warpUrl })
  try {
    const inserted = await warp.execute({
      sql: 'INSERT OR IGNORE INTO activity (source_id, activity_id, customer_id) VALUES (?, ?, ?)',
      args: [payload.sourceId, activityId, 'synthetic-warp-customer'],
    })
    const row = await warp.execute({ sql: 'SELECT activity_id, customer_id FROM activity WHERE source_id = ?', args: [payload.sourceId] })
    assert.equal(row.rows.length, 1)
    if (current?.pause) {
      reply({ event: 'remote-committed', activityId })
      await new Promise(() => {})
    }
    return Response.json({
      ok: true,
      customerId: String(row.rows[0].customer_id),
      activityId: String(row.rows[0].activity_id),
      created: inserted.rowsAffected === 1,
      duplicate: inserted.rowsAffected === 0,
    })
  } finally {
    warp.close()
  }
}

let current: Command | undefined
async function execute(command: Command) {
  current = command
  const now = () => new Date(command.at)
  try {
    if (command.action === 'claim') reply({ event: 'result', claimed: await claimWorker(db, owner, now()) })
    else if (command.action === 'dispatch') reply({ event: 'result', ...(await dispatchPendingWarp(db, owner, send as typeof fetch, env, now)) })
    else if (command.action === 'release') { await releaseWorker(db, owner, now()); reply({ event: 'result' }) }
    else { await db.$disconnect(); reply({ event: 'result' }); process.disconnect!() }
  } catch (error) {
    if (error instanceof SyncError) reply({ event: 'result', error: error.type })
    else throw error
  } finally {
    current = undefined
  }
}

process.on('message', (command: Command) => void execute(command).catch(async (error) => {
  reply({ event: 'error', error: error instanceof Error ? error.stack : String(error) })
  process.exitCode = 1
  await db.$disconnect()
  process.disconnect?.()
}))
reply({ event: 'ready' })
