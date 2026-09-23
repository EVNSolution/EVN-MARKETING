import { constants } from 'node:fs'
import { lstat, open, realpath, stat } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { keyConfigured } from '@/lib/warp-delivery'
import { applyWarpRecovery, MAX_PLAN_BYTES, parseRecoveryPlan, planWarpRecovery, recoveryErrorCode, recoverySha256, validateRecoveryIds } from '@/lib/warp-recovery'

// Raw CLI is supported ONLY inside encrypted Marketing EBS storage with operator-only
// directories/files. The host wrapper verifies encryption and holds the maintenance
// lock with all known writers stopped; this CLI cannot verify the EBS provenance.
async function privateDirectory(file: string) {
  // Reject traversal before normalization, which could otherwise hide a symlink/.. ancestor.
  if (file.split(path.sep).includes('..')) throw new Error()
  const absolute = path.resolve(file)
  const directory = path.dirname(absolute)
  if (await realpath(directory) !== directory) throw new Error()
  const info = await lstat(directory)
  if (!info.isDirectory() || (info.mode & 0o7777) !== 0o700) throw new Error()
  return absolute
}

async function readInput(file: string) {
  const absolute = await privateDirectory(file)
  const handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const info = await handle.stat()
    if (!info.isFile() || info.size > MAX_PLAN_BYTES || (info.mode & 0o7777) !== 0o600 || info.nlink !== 1) throw new Error()
    const bytes = await handle.readFile('utf8')
    if (Buffer.byteLength(bytes) > MAX_PLAN_BYTES) throw new Error()
    return bytes
  } finally { await handle.close() }
}

async function privateOutput(file: string) {
  const absolute = await privateDirectory(file)
  const handle = await open(absolute, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
  try {
    await handle.chmod(0o600)
    const directory = await open(path.dirname(absolute), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
    try { await directory.sync() } finally { await directory.close() }
    return handle
  } catch (error) { await handle.close(); throw error }
}

async function main() {
  const [mode, input, output, approval, ...extra] = process.argv.slice(2)
  if (extra.length || !input || (mode === 'plan' ? !output || approval !== undefined
    : mode !== 'apply' || output !== '--approve-sha256' || !approval)) {
    return { status: 'usage: node warp-recovery.mjs plan INPUT_IDS_JSON OUTPUT_PLAN | apply PLAN --approve-sha256 HASH' }
  }
  if (mode === 'apply' && !keyConfigured()) return { status: 'warp_key_required' }
  const bytes = await readInput(input)
  let ids: unknown
  if (mode === 'plan') {
    ids = JSON.parse(bytes)
    validateRecoveryIds(ids)
  } else parseRecoveryPlan(bytes, approval!)

  // Recovery never falls back to dev.db and never creates a missing database.
  const databaseUrl = process.env.DATABASE_URL
  if (!databaseUrl?.startsWith('file:') || !path.isAbsolute(databaseUrl.slice(5))
    || !(await stat(databaseUrl.slice(5))).isFile()) return { status: 'warp_recovery_database_required' }
  const controller = new AbortController()
  const stop = () => controller.abort()
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
  const { createPrisma } = await import('@/lib/db')
  const db = createPrisma(databaseUrl)
  try {
    if (mode === 'plan') {
      const plan = await planWarpRecovery(db, ids)
      const serialized = `${JSON.stringify(plan, null, 2)}\n`
      if (controller.signal.aborted) return { status: 'warp_recovery_interrupted' }
      const handle = await privateOutput(output)
      try { await handle.writeFile(serialized); await handle.sync() } finally { await handle.close() }
      return { status: 'ok', comparison: 'local-only', selected: plan.rows.length, sha256: recoverySha256(serialized) }
    }
    const runId = randomUUID()
    // Never append to caller-controlled existing files or put source IDs in stdout.
    const audit = await privateOutput(`${input}.apply-${runId}.jsonl`)
    try {
      const result = await applyWarpRecovery(db, bytes, approval!, {
        signal: controller.signal,
        audit: async event => { await audit.writeFile(`${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`); await audit.sync() },
      })
      return result
    } finally { await audit.close() }
  } finally {
    await db.$disconnect()
    process.off('SIGINT', stop)
    process.off('SIGTERM', stop)
  }
}

main().then(result => {
  console.log(JSON.stringify(result))
  if (result.status !== 'ok') process.exitCode = 1
}).catch(error => {
  console.log(JSON.stringify({ status: recoveryErrorCode(error) }))
  process.exitCode = 1
})
