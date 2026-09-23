import assert from 'node:assert/strict'
import { once } from 'node:events'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3'
import { PrismaClient } from '@/app/generated/prisma/client'
import { writeCustomerUpload } from '@/lib/upload-security'

const [url, root, kind, mode] = process.argv.slice(2)
assert.ok(url.startsWith('file:') && url.includes('evn-worker-test-'))
assert.ok(root.includes('evn-worker-test-'))
const db = new PrismaClient({
  adapter: new PrismaBetterSqlite3({ url, timeout: 5000 }, { timestampFormat: 'iso8601' }),
  transactionOptions: { timeout: mode === 'expire' ? 1000 : 5000 },
})
let updates = 0
let opens = 0
const locked = db.$extends({ query: {
  async $executeRaw({ args, query }) {
    if (++updates > 1) return query(args)
    let proceed = once(process, 'message')
    process.send!({ event: 'attempt' })
    await proceed
    const count = await query(args)
    proceed = once(process, 'message')
    process.send!({ event: 'locked' })
    await proceed
    return count
  },
} })

if (mode === 'fail-write') {
  const original = fs.writeFileSync
  fs.writeFileSync = (file, data, options) => {
    if (typeof file === 'number') {
      fs.writeSync(file, Buffer.from('synthetic partial write'))
      throw new Error('synthetic disk write failure')
    }
    return original(file, data, options)
  }
  syncBuiltinESMExports()
}
if (mode === 'expire') {
  const original = fs.openSync
  fs.openSync = (file, flags, permissions) => {
    if (String(file).startsWith(root)) opens++
    return original(file, flags, permissions)
  }
  syncBuiltinESMExports()
}

async function main() {
  const start = once(process, 'message')
  process.send!({ event: 'ready' })
  await start
  const bytes = new Uint8Array(4 * 1024 * 1024)
  bytes.set(kind === 'image' ? [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] : Buffer.from('%PDF-1.7'))
  const file = new File([bytes], kind === 'image' ? 'synthetic.png' : 'synthetic.pdf', { type: kind === 'image' ? 'image/png' : 'application/pdf' })
  try {
    const written = await writeCustomerUpload(locked as PrismaClient, root, 'upload-customer', file, kind === 'image' ? 'image' : 'document', kind === 'image' ? 'contacts' : undefined)
    if (mode === 'orphan') {
      const resume = once(process, 'message')
      process.send!({ event: 'written', ...written })
      await resume
    }
    process.send!({ event: 'result', ...written })
  } catch (error) {
    process.send!({ event: 'result', error: error instanceof Error && 'code' in error ? error.code : error instanceof Error ? error.message : String(error), ...(mode === 'expire' && { opens }) })
  } finally {
    await db.$disconnect()
    process.disconnect!()
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; process.disconnect?.() })
