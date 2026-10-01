import 'dotenv/config'
import { randomUUID } from 'node:crypto'
import { checkWarpConnection, keyConfigured, pilotPendingWarp } from '@/lib/warp-delivery'

async function main() {
  const mode = process.argv[2]
  if (process.argv.length !== 3 || (mode !== 'check' && mode !== 'pilot')) {
    return 'usage: node warp-delivery.mjs check|pilot\nusage: npm run warp:delivery -- check|pilot'
  }
  if (!keyConfigured()) return 'warp_key_required'
  if (mode === 'check') return checkWarpConnection()

  const { createPrisma } = await import('@/lib/db')
  const { claimWorker, releaseWorker } = await import('@/lib/inquiry-sync')
  const db = createPrisma()
  const owner = randomUUID()
  let claimed = false
  try {
    claimed = await claimWorker(db, owner)
    if (!claimed) return 'worker_already_running'
    return await pilotPendingWarp(db, owner)
  } finally {
    try {
      if (claimed) await releaseWorker(db, owner)
    } finally {
      await db.$disconnect()
    }
  }
}

main().then((result) => {
  console.log(result)
  if (result !== 'ok' && result !== 'ok_recovered_receipt_unverified') process.exitCode = 1
}).catch(() => {
  console.error('warp_delivery_command_failed')
  process.exitCode = 1
})
