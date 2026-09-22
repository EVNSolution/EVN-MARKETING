import { constants } from 'node:fs'
import { lstat, mkdir, open, readdir, realpath, rename, unlink } from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024
export const MAX_CUSTOMER_BYTES = 50 * 1024 * 1024
export const MAX_MULTIPART_BYTES = MAX_UPLOAD_BYTES + 64 * 1024
const uploadLocks = new Map<string, Promise<void>>()

export type Contact = {
  id: string
  name: string
  phone: string
  title: string
  role: string
  email: string
  note: string
  cardUrl: string | null
}

export type DocMeta = { type: string; name: string; path: string; size: number; uploadedAt: string }

const IMAGE_TYPES: Record<string, string> = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif',
  '.webp': 'image/webp', '.bmp': 'image/bmp', '.heic': 'image/heic',
}
const DOCUMENT_TYPES: Record<string, string> = {
  ...IMAGE_TYPES,
  '.pdf': 'application/pdf',
}

function parseArray<T>(value: string | null, label: string, valid: (item: unknown) => item is T): T[] {
  if (value === null) return []
  let parsed: unknown
  try { parsed = JSON.parse(value) } catch { throw new Error(`invalid_${label}_metadata`) }
  if (!Array.isArray(parsed) || !parsed.every(valid)) throw new Error(`invalid_${label}_metadata`)
  return parsed
}

const isString = (value: unknown): value is string => typeof value === 'string'

function isContact(value: unknown): value is Contact {
  if (!value || typeof value !== 'object') return false
  const item = value as Record<string, unknown>
  return ['id', 'name', 'phone', 'title', 'role', 'email', 'note'].every(key => isString(item[key]))
    && (item.cardUrl === null || isString(item.cardUrl))
}

function isDoc(value: unknown): value is DocMeta {
  if (!value || typeof value !== 'object') return false
  const item = value as Record<string, unknown>
  return isString(item.type) && isString(item.name) && isString(item.path)
    && typeof item.size === 'number' && Number.isFinite(item.size) && item.size >= 0
    && isString(item.uploadedAt)
}

export const parseContacts = (value: string | null) => parseArray(value, 'contacts', isContact)
export const parseDocuments = (value: string | null) => parseArray(value, 'documents', isDoc)

export function mergeContacts(currentJson: string | null, requested: unknown): string | null {
  const current = parseContacts(currentJson)
  if (requested === null) requested = '[]'
  if (typeof requested !== 'string') throw new Error('invalid_contacts_metadata')
  const incoming = parseContacts(requested)
  if (new Set(incoming.map(contact => contact.id)).size !== incoming.length) throw new Error('invalid_contacts_metadata')
  const oldById = new Map(current.map(contact => [contact.id, contact]))
  const merged = incoming.map(contact => ({ ...contact, cardUrl: oldById.get(contact.id)?.cardUrl ?? null }))
  if (current.some(contact => contact.cardUrl && !incoming.some(item => item.id === contact.id))) {
    throw new Error('contact_card_must_be_deleted_first')
  }
  return merged.length ? JSON.stringify(merged) : null
}

function safeCustomerId(id: string) {
  if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error('invalid_customer_path')
}

function inside(base: string, target: string) {
  const relative = path.relative(base, target)
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
}

async function mkdirOnce(directory: string) {
  try { await mkdir(directory) } catch (error) {
    if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'EEXIST') throw error
  }
}

async function customerDirectory(root: string, customerId: string, create = false) {
  safeCustomerId(customerId)
  if (create) await mkdir(root, { recursive: true })
  const rootPath = await realpath(root)
  const customersPath = path.join(rootPath, 'customers')
  const customerPath = path.join(rootPath, 'customers', customerId)
  if (create) await mkdirOnce(customersPath)
  const customersInfo = await lstat(customersPath)
  if (!customersInfo.isDirectory() || customersInfo.isSymbolicLink()) throw new Error('invalid_customer_path')
  if (create) await mkdirOnce(customerPath)
  for (const directory of [customerPath]) {
    const info = await lstat(directory)
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('invalid_customer_path')
  }
  const resolved = await realpath(customerPath)
  if (!inside(rootPath, resolved)) throw new Error('invalid_customer_path')
  return resolved
}

function decodeSegment(segment: string) {
  let decoded = segment
  for (let i = 0; i < 4; i++) {
    let next: string
    try { next = decodeURIComponent(decoded) } catch { throw new Error('invalid_upload_path') }
    if (next === decoded) break
    decoded = next
  }
  if (!decoded || decoded === '.' || decoded === '..' || decoded.includes('/') || decoded.includes('\\') || decoded.includes('\0') || decoded.includes('%')) {
    throw new Error('invalid_upload_path')
  }
  return decoded
}

async function existingCustomerFile(root: string, customerId: string, segments: string[]) {
  safeCustomerId(customerId)
  const decoded = segments.map(decodeSegment)
  if (decoded[0] !== 'customers' || decoded[1] !== customerId || decoded.length < 3) throw new Error('invalid_upload_path')
  const customerPath = await customerDirectory(root, customerId)
  const candidate = path.join(await realpath(root), ...decoded)
  const resolved = await realpath(candidate)
  if (!inside(customerPath, resolved)) throw new Error('invalid_upload_path')
  const info = await lstat(candidate)
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('invalid_upload_path')
  return { candidate, resolved }
}

export async function removeOwnedUpload(root: string, customerId: string, url: string) {
  const prefix = '/api/uploads/'
  if (!url.startsWith(prefix) || url.includes('?') || url.includes('#')) throw new Error('invalid_upload_path')
  const { candidate } = await existingCustomerFile(root, customerId, url.slice(prefix.length).split('/'))
  await unlink(candidate)
}

export async function stageOwnedUpload(root: string, customerId: string, url: string) {
  const prefix = '/api/uploads/'
  if (!url.startsWith(prefix) || url.includes('?') || url.includes('#')) throw new Error('invalid_upload_path')
  const { candidate } = await existingCustomerFile(root, customerId, url.slice(prefix.length).split('/'))
  const staged = `${candidate}.deleting-${randomUUID()}`
  await rename(candidate, staged)
  return { original: candidate, staged }
}

export async function restoreStagedUpload(staged: { original: string; staged: string }) {
  await rename(staged.staged, staged.original)
}

export async function finishStagedUpload(staged: { staged: string }) {
  await unlink(staged.staged)
}

async function directoryBytes(directory: string): Promise<number> {
  let total = 0
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const item = path.join(directory, entry.name)
    if (entry.isSymbolicLink()) throw new Error('invalid_upload_path')
    if (entry.isDirectory()) total += await directoryBytes(item)
    else if (entry.isFile()) total += (await lstat(item)).size
  }
  return total
}

function matchesMagic(buffer: Buffer, ext: string) {
  if (ext === '.jpg' || ext === '.jpeg') return buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff
  if (ext === '.png') return buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  if (ext === '.gif') return ['GIF87a', 'GIF89a'].includes(buffer.subarray(0, 6).toString('ascii'))
  if (ext === '.webp') return buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP'
  if (ext === '.bmp') return buffer.subarray(0, 2).toString('ascii') === 'BM'
  if (ext === '.heic') return buffer.subarray(4, 8).toString('ascii') === 'ftyp' && /^(heic|heix|hevc|hevx|mif1|msf1)$/.test(buffer.subarray(8, 12).toString('ascii'))
  if (ext === '.pdf') return buffer.subarray(0, 5).toString('ascii') === '%PDF-'
  return false
}

export async function validateUpload(file: File, kind: 'image' | 'document') {
  if (!file.name || file.size <= 0 || file.size > MAX_UPLOAD_BYTES) throw new Error('invalid_upload_size')
  const ext = path.extname(file.name).toLowerCase()
  const allowed = kind === 'image' ? IMAGE_TYPES : DOCUMENT_TYPES
  const expectedType = allowed[ext]
  if (!expectedType || (file.type && file.type !== expectedType)) throw new Error('invalid_upload_type')
  const buffer = Buffer.from(await file.arrayBuffer())
  if (buffer.length !== file.size || !matchesMagic(buffer, ext)) throw new Error('invalid_upload_type')
  return { buffer, ext }
}

export function validateMultipartLength(request: Request) {
  const value = request.headers.get('content-length')
  const length = value && /^\d+$/.test(value) ? Number(value) : NaN
  if (!Number.isSafeInteger(length) || length <= 0) throw new Error('upload_length_required')
  if (length > MAX_MULTIPART_BYTES) throw new Error('invalid_upload_size')
}

async function withUploadLock<T>(key: string, work: () => Promise<T>) {
  const previous = uploadLocks.get(key) ?? Promise.resolve()
  let release!: () => void
  const current = new Promise<void>(resolve => { release = resolve })
  const queued = previous.then(() => current)
  uploadLocks.set(key, queued)
  await previous
  try { return await work() } finally {
    release()
    if (uploadLocks.get(key) === queued) uploadLocks.delete(key)
  }
}

export async function writeCustomerUpload(root: string, customerId: string, file: File, kind: 'image' | 'document', subdir?: 'contacts') {
  const { buffer, ext } = await validateUpload(file, kind)
  // ponytail: this lock bounds concurrent uploads in one web process; use a shared reservation if the web tier scales out.
  return withUploadLock(`${path.resolve(root)}:${customerId}`, async () => {
    const customerPath = await customerDirectory(root, customerId, true)
    if (await directoryBytes(customerPath) + buffer.length > MAX_CUSTOMER_BYTES) throw new Error('customer_upload_quota_exceeded')
    const directory = subdir ? path.join(customerPath, subdir) : customerPath
    await mkdir(directory, { recursive: true })
    const directoryInfo = await lstat(directory)
    if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) throw new Error('invalid_customer_path')
    const resolvedDirectory = await realpath(directory)
    if (!inside(customerPath, resolvedDirectory)) throw new Error('invalid_customer_path')
    const name = `${randomUUID()}${ext}`
    const filename = path.join(resolvedDirectory, name)
    const handle = await open(filename, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600)
    try {
      await handle.writeFile(buffer)
    } catch {
      try { await handle.close(); await unlink(filename) } catch { throw new Error('partial_upload_cleanup_failed') }
      throw new Error('upload_write_failed')
    }
    await handle.close()
    return {
      filename,
      url: `/api/uploads/customers/${customerId}/${subdir ? `${subdir}/` : ''}${name}`,
    }
  })
}

export async function rollbackNewUpload(filename: string) {
  await unlink(filename)
}

export function requireMetadataUpdate(count: number) {
  if (count !== 1) throw new Error('upload_metadata_changed')
}

export async function commitNewUpload(filename: string, update: () => Promise<void>) {
  try {
    await update()
  } catch (error) {
    try { await rollbackNewUpload(filename) } catch { throw new Error('database_update_failed_and_new_upload_cleanup_failed') }
    throw error
  }
}

export async function deleteOwnedUpload(
  root: string,
  customerId: string,
  url: string | null,
  update: () => Promise<void>,
  restoreMetadata: () => Promise<void>,
  finish = finishStagedUpload,
) {
  const staged = url ? await stageOwnedUpload(root, customerId, url) : null
  try {
    await update()
  } catch (error) {
    if (staged) {
      try { await restoreStagedUpload(staged) } catch { throw new Error('delete_rollback_failed') }
    }
    throw error
  }
  if (!staged) return
  try {
    await finish(staged)
  } catch {
    try {
      await restoreMetadata()
      await restoreStagedUpload(staged)
    } catch { throw new Error('delete_rollback_failed') }
    throw new Error('old_upload_cleanup_failed')
  }
}

export async function uploadResponse(root: string, segments: string[], authenticated: boolean) {
  const headers = {
    'Cache-Control': 'private, no-store, max-age=0',
    'Pragma': 'no-cache',
    'X-Content-Type-Options': 'nosniff',
  }
  if (!authenticated) return new Response('Unauthorized', { status: 401, headers })
  try {
    if (segments.length < 3 || segments[0] !== 'customers') throw new Error('invalid_upload_path')
    const { resolved } = await existingCustomerFile(root, decodeSegment(segments[1]), segments)
    const handle = await open(resolved, constants.O_RDONLY | constants.O_NOFOLLOW)
    let buffer: Buffer
    try {
      if (!(await handle.stat()).isFile()) throw new Error('invalid_upload_path')
      buffer = await handle.readFile()
    } finally { await handle.close() }
    const ext = path.extname(resolved).toLowerCase()
    const contentType = DOCUMENT_TYPES[ext] ?? 'application/octet-stream'
    const disposition = ext in IMAGE_TYPES ? 'inline' : 'attachment'
    return new Response(Uint8Array.from(buffer), {
      headers: {
        ...headers,
        'Content-Type': contentType,
        'Content-Disposition': `${disposition}; filename="${path.basename(resolved).replace(/["\\]/g, '_')}"`,
      },
    })
  } catch {
    return new Response('Not found', { status: 404, headers })
  }
}
