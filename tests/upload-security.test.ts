import assert from 'node:assert/strict'
import { access, mkdir, mkdtemp, readFile, rm, symlink, truncate, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { safeReturnTo } from '@/lib/customer-security'
import {
  MAX_MULTIPART_BYTES,
  MAX_UPLOAD_BYTES,
  commitNewUpload,
  deleteOwnedUpload,
  mergeContacts,
  parseDocuments,
  removeOwnedUpload,
  requireMetadataUpdate,
  uploadResponse,
  validateMultipartLength,
  validateUpload,
  writeCustomerUpload,
} from '@/lib/upload-security'

const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const image = (name = 'card.png') => new File([png], name, { type: 'image/png' })

async function missing(filename: string) {
  await assert.rejects(access(filename))
}

async function main() {
  const base = await mkdtemp(path.join(tmpdir(), 'evn-upload-security-'))
  const root = path.join(base, 'uploads')
  const outside = path.join(base, 'sentinel.txt')
  await writeFile(outside, 'keep')

  try {
    const first = await writeCustomerUpload(root, 'customer-a', image(), 'image', 'contacts')
    assert.equal(await readFile(first.filename, 'hex'), Buffer.from(png).toString('hex'))

    const denied = await uploadResponse(root, first.url.slice('/api/uploads/'.length).split('/'), false)
    assert.equal(denied.status, 401)
    assert.equal(denied.headers.get('cache-control'), 'private, no-store, max-age=0')
    assert.equal(denied.headers.get('x-content-type-options'), 'nosniff')

    const served = await uploadResponse(root, first.url.slice('/api/uploads/'.length).split('/'), true)
    assert.equal(served.status, 200)
    assert.equal(served.headers.get('content-type'), 'image/png')
    assert.match(served.headers.get('content-disposition') ?? '', /^inline;/)
    assert.deepEqual(new Uint8Array(await served.arrayBuffer()), png)

    const pdf = await writeCustomerUpload(root, 'customer-a', new File(['%PDF-1.7'], 'record.pdf', { type: 'application/pdf' }), 'document')
    const pdfResponse = await uploadResponse(root, pdf.url.slice('/api/uploads/'.length).split('/'), true)
    assert.match(pdfResponse.headers.get('content-disposition') ?? '', /^attachment;/)

    assert.equal((await uploadResponse(root, ['customers', 'customer-a', '%252e%252e', 'sentinel.txt'], true)).status, 404)
    assert.equal(await readFile(outside, 'utf8'), 'keep')
    await assert.rejects(removeOwnedUpload(root, 'customer-a', '/api/uploads/customers/customer-b/file.png'), /invalid_upload_path/)
    await assert.rejects(removeOwnedUpload(root, 'customer-a', '/api/uploads/customers/customer-a/%252e%252e/sentinel.txt'), /invalid_upload_path/)

    const customerDir = path.join(root, 'customers', 'customer-a')
    await symlink(outside, path.join(customerDir, 'linked.png'))
    assert.equal((await uploadResponse(root, ['customers', 'customer-a', 'linked.png'], true)).status, 404)
    await assert.rejects(removeOwnedUpload(root, 'customer-a', '/api/uploads/customers/customer-a/linked.png'), /invalid_upload_path/)
    assert.equal(await readFile(outside, 'utf8'), 'keep')

    await mkdir(path.join(root, 'customers', 'customer-b'))
    await symlink(path.join(root, 'customers', 'customer-b'), path.join(root, 'customers', 'customer-alias'))
    await assert.rejects(writeCustomerUpload(root, 'customer-alias', image(), 'image'), /invalid_customer_path/)

    assert.throws(() => parseDocuments('{bad json'), /invalid_documents_metadata/)
    assert.throws(() => parseDocuments('{}'), /invalid_documents_metadata/)
    const savedCard = '/api/uploads/customers/customer-a/contacts/original.png'
    const current = JSON.stringify([{ id: 'one', name: 'A', phone: '', title: '', role: '', email: '', note: '', cardUrl: savedCard }])
    const injected = JSON.stringify([{ id: 'one', name: 'B', phone: '', title: '', role: '', email: '', note: '', cardUrl: '/api/uploads/customers/customer-b/stolen.png' }])
    assert.equal(JSON.parse(mergeContacts(current, injected)!).at(0).cardUrl, savedCard)
    assert.throws(() => mergeContacts(current, '[]'), /contact_card_must_be_deleted_first/)
    assert.throws(() => mergeContacts(current, '{bad'), /invalid_contacts_metadata/)

    assert.equal(safeReturnTo('/inquiries?status=new'), '/inquiries?status=new')
    for (const malicious of ['https://evil.example', '//evil.example', 'javascript:alert(1)', '/customers', '/inquiries.evil', '/%2finquiries']) {
      assert.equal(safeReturnTo(malicious), undefined)
    }

    await assert.rejects(validateUpload(new File(['not an image'], 'fake.png', { type: 'image/png' }), 'image'), /invalid_upload_type/)
    await assert.rejects(validateUpload(new File([new Uint8Array(MAX_UPLOAD_BYTES + 1)], 'huge.png', { type: 'image/png' }), 'image'), /invalid_upload_size/)
    assert.throws(() => validateMultipartLength(new Request('http://internal/upload', { method: 'POST' })), /upload_length_required/)
    assert.throws(() => validateMultipartLength(new Request('http://internal/upload', { method: 'POST', headers: { 'content-length': String(MAX_MULTIPART_BYTES + 1) } })), /invalid_upload_size/)

    const quotaCustomer = path.join(root, 'customers', 'quota')
    await mkdir(quotaCustomer)
    await writeFile(path.join(quotaCustomer, 'existing.bin'), '')
    await truncate(path.join(quotaCustomer, 'existing.bin'), 50 * 1024 * 1024)
    await assert.rejects(writeCustomerUpload(root, 'quota', image(), 'image'), /customer_upload_quota_exceeded/)

    const old = await writeCustomerUpload(root, 'ordering', image('old.png'), 'image')
    const replacement = await writeCustomerUpload(root, 'ordering', image('new.png'), 'image')
    await assert.rejects(commitNewUpload(replacement.filename, async () => requireMetadataUpdate(0)), /upload_metadata_changed/)
    await access(old.filename)
    await missing(replacement.filename)

    await assert.rejects(deleteOwnedUpload(root, 'ordering', old.url, async () => { throw new Error('synthetic_db_failure') }, async () => {}), /synthetic_db_failure/)
    await access(old.filename)

    let metadata = old.url
    await assert.rejects(deleteOwnedUpload(root, 'ordering', old.url, async () => { metadata = '' }, async () => { metadata = old.url }, async () => {
      throw new Error('synthetic_unlink_failure')
    }), /old_upload_cleanup_failed/)
    assert.equal(metadata, old.url)
    await access(old.filename)

    const removable = await writeCustomerUpload(root, 'ordering', image('remove.png'), 'image')
    await deleteOwnedUpload(root, 'ordering', removable.url, async () => {}, async () => {})
    await missing(removable.filename)

    console.log('upload security checks passed')
  } finally {
    await rm(base, { recursive: true, force: true })
  }
}

main().catch(error => { console.error(error); process.exitCode = 1 })
