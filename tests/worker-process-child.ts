import { dispatchPendingWarp } from './warp-phone-check-helper'
import assert from 'node:assert/strict'
import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3'
import { PrismaClient } from '@/app/generated/prisma/client'
import { claimNextRun, claimWorker, finishRun, heartbeatWorker, reconcile, releaseWorker, SyncError } from '@/lib/inquiry-sync'
import { warpActivityId } from '@/lib/warp-delivery'
import { completedLead } from './customer-lead-helper'

export type Command = {
  action: 'claim' | 'collect' | 'dispatch' | 'heartbeat' | 'release' | 'continue' | 'close'
  at: number
  pause?: boolean
  duplicate?: boolean
}
export type Reply = {
  event: 'ready' | 'barrier' | 'result' | 'error'
  claimed?: boolean
  runId?: string
  status?: string
  error?: string
  finishError?: string
  pages?: number
  calls?: number
  delivered?: number
  unchangedCount?: number
  activityId?: string
}

const [url, owner] = process.argv.slice(2)
assert.ok(url?.startsWith('file:') && url.includes('evn-worker-test-'), 'only the synthetic fixture database is allowed')
assert.ok(owner)
const db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url, timeout: 5000 }, { timestampFormat: 'iso8601' }) })
const env = { WARP_DELIVERY_ENABLED: 'true', WARP_MARKETING_API_KEY: 'synthetic-process-test-key-00000000' }
globalThis.fetch = async () => { throw new Error('unexpected network access') }
let resume: (() => void) | undefined

function reply(value: Reply) { process.send!(value) }
async function barrier(value: Partial<Reply> = {}) {
  await new Promise<void>((resolve) => {
    resume = resolve
    reply({ ...value, event: 'barrier' })
  })
  resume = undefined
}

async function execute(command: Command) {
  const now = () => new Date(command.at)
  let calls = 0
  try {
    switch (command.action) {
      case 'claim': {
        // Both processes stop immediately before the actual atomic lease update.
        const contender = command.pause ? db.$extends({ query: { inquirySyncState: {
          async updateMany({ args, query }) { await barrier(); return query(args) },
        } } }) : db
        reply({ event: 'result', claimed: await claimWorker(contender as PrismaClient, owner, now()) })
        break
      }
      case 'collect': {
        const run = await claimNextRun(db, now(), owner, '2026-09-22')
        if (!run) { reply({ event: 'result', pages: 0 }); break }
        let pages = 0
        const result = await reconcile(db, run.id, owner, run.rangeStart, run.rangeEnd, async (page) => {
          pages++
          if (command.pause) await barrier({ runId: run.id, pages })
          return { page, total: 1, rows: [{ sourceId: '00000000-0000-4000-8000-000000000001', inquiryDate: '2026-09-22', inquiryTime: '09:00', phone: '010-0000-0000', name: null, sourceStatus: null }] }
        }, now)
        let finishError: string | undefined
        try { await finishRun(db, run.id, owner, result, now()) } catch (error) {
          if (!(error instanceof SyncError)) throw error
          finishError = error.type
        }
        reply({ event: 'result', runId: run.id, pages, status: result.status, error: result.errorType, unchangedCount: result.unchangedCount, finishError })
        break
      }
      case 'dispatch': {
        const result = await dispatchPendingWarp(db, owner, async (url, init) => {
          assert.equal(url, 'https://warp.cleversystem.ai/api/external/marketing-inquiries')
          calls++
          const input = JSON.parse(String(init?.body))
          assert.equal(input.registrationPolicy, 'customer-lead-v1')
          const activityId = warpActivityId(input.sourceId)
          const receipt = { ok: true, customerId: 'synthetic-customer', activityId, created: !command.duplicate,
            duplicate: Boolean(command.duplicate), ...completedLead(input, activityId) }
          // Model a remote commit whose response has not reached the sender yet.
          if (command.pause) await barrier({ calls, activityId: receipt.activityId })
          return Response.json(receipt)
        }, env, now)
        reply({ event: 'result', calls, delivered: result.delivered })
        break
      }
      case 'heartbeat': await heartbeatWorker(db, owner, now()); reply({ event: 'result' }); break
      case 'release': await releaseWorker(db, owner, now()); reply({ event: 'result' }); break
      case 'close': await db.$disconnect(); reply({ event: 'result' }); process.disconnect!(); break
      default: throw new Error('unexpected command')
    }
  } catch (error) {
    if (error instanceof SyncError) reply({ event: 'result', error: error.type, calls })
    else throw error
  }
}

process.on('message', (command: Command) => {
  if (command.action === 'continue') { assert.ok(resume); resume(); return }
  void execute(command).catch((error) => {
    reply({ event: 'error', error: error instanceof Error ? error.stack : String(error) })
    process.exitCode = 1
    void db.$disconnect().finally(() => process.disconnect?.())
  })
})
reply({ event: 'ready' })
