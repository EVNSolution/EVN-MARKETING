import { constants } from 'node:fs'
import { lstat, mkdir, open, realpath, rename, unlink } from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { applyAdSpendAction, emptyAdSpend, parseAdSpendRecord, selectAdSpend, type AdSpendAction } from './ad-spend'
type Environment = { [key: string]: string | undefined; UPLOADS_DIR?: string }
const maximum = 32 * 1024 * 1024
const absent = (error: unknown) => Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')
const invalid = (): never => { throw new Error('ad_spend_storage_error') }
async function sync(folder: string) {
  if (process.platform === 'win32') return
  const fd = await open(folder, 'r'); try { await fd.sync() } finally { await fd.close() }
}
async function directory(env: Environment, create: boolean) {
  const root = path.resolve(env.UPLOADS_DIR || path.join(process.cwd(), 'uploads'))
  if (create) await mkdir(root, { recursive: true, mode: 0o700 })
  const folders = [root, path.join(root, '_reports'), path.join(root, '_reports/ad-spend')]
  for (const [index, folder] of folders.entries()) {
    if (create && index) {
      try { await mkdir(folder, { mode: 0o700 }); await sync(path.dirname(folder)) } catch (error) {
        if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'EEXIST') throw error
      }
    }
    const stat = await lstat(folder)
    if (!stat.isDirectory() || stat.isSymbolicLink() || await realpath(folder) !== folder) return invalid()
  }
  return folders[2]
}
async function read(file: string) {
  try {
    const stat = await lstat(file)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > maximum) return invalid()
    const fd = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0))
    try {
      const opened = await fd.stat()
      if (!opened.isFile() || opened.nlink !== 1 || opened.size > maximum || opened.ino !== stat.ino || opened.dev !== stat.dev) return invalid()
      const bytes = await fd.readFile()
      if (bytes.length > maximum) return invalid()
      return parseAdSpendRecord(JSON.parse(bytes.toString('utf8')))
    } finally { await fd.close() }
  } catch (error) { if (absent(error)) return emptyAdSpend(); return invalid() }
}
export async function readAdSpend(env: Environment = process.env) {
  let folder: string
  try { folder = await directory(env, false) } catch (error) { if (absent(error)) return emptyAdSpend(); throw error }
  return read(path.join(folder, 'current.json'))
}
export async function readAdSpendView(start: string, end: string, env: Environment = process.env) {
  return selectAdSpend(await readAdSpend(env), start, end)
}
export async function saveAdSpend(action: AdSpendAction, env: Environment = process.env, now = new Date()) {
  const folder = await directory(env, true), file = path.join(folder, 'current.json'), lockPath = path.join(folder, 'writer.lock')
  // Cross-process exclusion: never steal a lock. After a crash an operator must stop all writers before removing it.
  const lock = await open(lockPath, 'wx', 0o600).catch(() => { throw new Error('ad_spend_writer_busy') })
  const temporary = path.join(folder, `${randomUUID()}.tmp`)
  try {
    const next = applyAdSpendAction(await read(file), action, now), bytes = JSON.stringify(next)
    if (Buffer.byteLength(bytes) > maximum) return invalid()
    const fd = await open(temporary, 'wx', 0o600)
    try { await fd.writeFile(bytes); await fd.sync() } finally { await fd.close() }
    if (await directory(env, false) !== folder) return invalid()
    await rename(temporary, file); await sync(folder)
    return next
  } finally {
    try { await unlink(temporary).catch(error => { if (!absent(error)) throw error }) }
    finally { await lock.close(); await unlink(lockPath) }
  }
}
