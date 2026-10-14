import { constants } from 'node:fs'
import { lstat, mkdir, open, realpath, rename, unlink } from 'node:fs/promises'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { BILLING_MAX_ROWS, BillingError, billingKinds, billingMonth, billingSum, emptyBilling, monthDays, orderedRows, parseBillingRecord, scopeKinds, selectBilling, type BillingRecord } from './ad-billing'
import type { BillingImport } from './ad-billing-csv'
type Environment = { [key: string]: string | undefined; UPLOADS_DIR?: string }
const maximum = 32 * 1024 * 1024
const absent = (error: unknown) => Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')
const invalid = (): never => { throw new BillingError('storage', '저장된 정산 자료를 확인하지 못했습니다. 기존 자료를 유지하며 관리자 확인이 필요합니다.', 503) }
export function billingRevision(record: BillingRecord) { return createHash('sha256').update(JSON.stringify(record)).digest('hex') }
async function sync(folder: string) {
  if (process.platform === 'win32') return
  const fd = await open(folder, 'r'); try { await fd.sync() } finally { await fd.close() }
}
async function directory(env: Environment, create: boolean) {
  const root = path.resolve(env.UPLOADS_DIR || path.join(process.cwd(), 'uploads'))
  if (create) await mkdir(root, { recursive: true, mode: 0o700 })
  const folders = [root, path.join(root, '_reports'), path.join(root, '_reports/ad-billing')]
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
async function read(file: string, month: string) {
  try {
    const stat = await lstat(file)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > maximum) return invalid()
    const fd = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0))
    try {
      const opened = await fd.stat()
      if (!opened.isFile() || opened.nlink !== 1 || opened.size > maximum || opened.ino !== stat.ino || opened.dev !== stat.dev) return invalid()
      const bytes = await fd.readFile()
      if (bytes.length > maximum) return invalid()
      return parseBillingRecord(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)), month)
    } finally { await fd.close() }
  } catch (error) { if (absent(error)) return emptyBilling(month); return invalid() }
}
export async function readBilling(month: string, env: Environment = process.env) {
  billingMonth(month)
  let folder: string
  try { folder = await directory(env, false) } catch (error) { if (absent(error)) return emptyBilling(month); return invalid() }
  return read(path.join(folder, `${month}.json`), month)
}
export function billingView(record: BillingRecord, now = new Date()) { return { ...selectBilling(record, now), revision: billingRevision(record) } }
export function replaceBilling(record: BillingRecord, input: BillingImport, now = new Date()) {
  const { source } = input, kinds = scopeKinds(source.scope), dates = monthDays(record.month).filter(date => date >= source.start && date <= source.end)
  if (!dates.length || source.start.slice(0, 7) !== record.month || source.end.slice(0, 7) !== record.month) throw new BillingError('invalid', '저장 월과 조회 기간이 다릅니다.')
  const replaced = record.days.filter(day => dates.includes(day.date) && kinds.includes(day.kind))
  if (replaced.length === dates.length * kinds.length && replaced.every(day => day.source.key === source.key)) return { record, unchanged: true }
  const next = { ...record, days: record.days.filter(day => !replaced.includes(day)) }
  for (const date of dates) for (const kind of kinds) {
    const rows = orderedRows(input.rows.filter(row => row.at.slice(0, 10) === date && row.type === (kind === 'topup' ? '유상캐시 충전' : '광고캐시 사용')))
    const previous = replaced.find(day => day.date === date && day.kind === kind)
    if (previous && (previous.source.capturedAt > source.capturedAt || (previous.source.capturedAt === source.capturedAt && JSON.stringify(orderedRows(previous.rows)) !== JSON.stringify(rows)))) throw new BillingError('stale_source', '더 최신 자료가 저장되어 있거나 같은 수집 기준시각의 내용이 다릅니다. 원본과 수집 기준시각을 확인해 주세요.', 409)
    next.days.push({ date, kind, rows, source, importedAt: now.toISOString() })
  }
  next.days.sort((a, b) => a.date.localeCompare(b.date) || a.kind.localeCompare(b.kind))
  if (next.days.reduce((count, day) => count + day.rows.length, 0) > BILLING_MAX_ROWS) throw new BillingError('limit', '월별 정산은 최대 20,000건까지 지원합니다.')
  for (const kind of billingKinds) billingSum(next.days.filter(day => day.kind === kind).flatMap(day => day.rows))
  return { record: parseBillingRecord(next, record.month), unchanged: false }
}
export function previewBilling(record: BillingRecord, input: BillingImport, now = new Date()) {
  const next = replaceBilling(record, input, now)
  return { source: input.source, revision: billingRevision(record), unchanged: next.unchanged,
    before: selectBilling(record, now), after: selectBilling(next.record, now),
    rowCount: input.rows.length, sample: input.rows.slice(0, 8) }
}
export type BillingPreview = ReturnType<typeof previewBilling>
export async function saveBilling(input: BillingImport, revision: string, env: Environment = process.env, now = new Date()) {
  const month = billingMonth(input.source.start.slice(0, 7)), folder = await directory(env, true)
  const file = path.join(folder, `${month}.json`), lockPath = path.join(folder, 'writer.lock')
  // Never steal a cross-process lock. Recovery requires all writers to stop first.
  const lock = await open(lockPath, 'wx', 0o600).catch(() => { throw new BillingError('busy', '다른 정산 자료를 저장 중입니다. 잠시 후 다시 시도해 주세요.', 409) })
  const temporary = path.join(folder, `${randomUUID()}.tmp`)
  try {
    const current = await read(file, month), next = replaceBilling(current, input, now)
    // Retrying a completed identical import is safe even with its original preview revision.
    if (next.unchanged) return { unchanged: true, view: billingView(current, now) }
    if (revision !== billingRevision(current)) throw new BillingError('changed', '미리보기 이후 저장 자료가 바뀌었습니다. 다시 미리보기 해주세요.', 409)
    const bytes = JSON.stringify(next.record)
    if (Buffer.byteLength(bytes) > maximum) return invalid()
    const fd = await open(temporary, 'wx', 0o600)
    try { await fd.writeFile(bytes); await fd.sync() } finally { await fd.close() }
    if (await directory(env, false) !== folder) return invalid()
    await rename(temporary, file); await sync(folder)
    return { unchanged: false, view: billingView(next.record, now) }
  } finally {
    try { await unlink(temporary).catch(error => { if (!absent(error)) throw error }) }
    finally { await lock.close(); await unlink(lockPath) }
  }
}
