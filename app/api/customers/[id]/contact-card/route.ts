import { NextRequest, NextResponse } from 'next/server'
import path from 'node:path'
import { prisma } from '@/lib/db'
import {
  commitNewUpload,
  deleteOwnedUpload,
  parseContacts,
  removeOwnedUpload,
  requireMetadataUpdate,
  validateMultipartLength,
  writeCustomerUpload,
} from '@/lib/upload-security'

const UPLOADS_DIR = process.env.UPLOADS_DIR ?? path.join(process.cwd(), 'uploads')

function failure(error: unknown) {
  const allowed: Record<string, number> = {
    invalid_upload_size: 413, customer_upload_quota_exceeded: 413, invalid_upload_type: 415,
    invalid_contacts_metadata: 409, invalid_upload_path: 409, invalid_customer_path: 409,
    upload_metadata_changed: 409, upload_length_required: 411,
    old_upload_cleanup_failed: 500, delete_rollback_failed: 500,
    database_update_failed_and_new_upload_cleanup_failed: 500,
    partial_upload_cleanup_failed: 500, upload_write_failed: 500,
  }
  const message = error instanceof Error ? error.message : ''
  const code = Object.hasOwn(allowed, message) ? message : 'upload_failed'
  const status = allowed[code] ?? 500
  const description = status === 413 ? '파일은 10MB 이하, 고객별 첨부파일은 총 50MB 이하로 올려주세요.'
    : status === 415 ? '명함은 지원되는 이미지 파일로 올려주세요.'
      : status === 409 ? '첨부파일 정보가 변경되었거나 올바르지 않습니다. 새로고침 후 확인해 주세요.'
        : status === 411 ? '파일 전송 정보를 확인하지 못했습니다. 파일을 다시 선택해 주세요.'
          : '파일 처리를 완료하지 못했습니다. 다시 확인하고 문제가 계속되면 관리자에게 알려주세요.'
  return NextResponse.json({ error: description, code }, { status })
}

async function cleanupOld(customerId: string, url: string | null) {
  if (!url) return undefined
  try {
    await removeOwnedUpload(UPLOADS_DIR, customerId, url)
  } catch {
    return 'old_upload_cleanup_failed'
  }
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  try {
    validateMultipartLength(req)
    const customer = await prisma.customer.findUnique({ where: { id } })
    if (!customer) return NextResponse.json({ error: 'Not found' }, { status: 404 })

    const contacts = parseContacts(customer.contactsJson)
    const form = await req.formData()
    const file = form.get('file')
    const contactId = form.get('contactId')
    if (!(file instanceof File) || (contactId !== null && typeof contactId !== 'string')) {
      return NextResponse.json({ error: 'Missing file' }, { status: 400 })
    }
    const target = typeof contactId === 'string' ? contacts.find(contact => contact.id === contactId) : undefined
    if (typeof contactId === 'string' && !target) return NextResponse.json({ error: 'Contact not found' }, { status: 404 })

    const written = await writeCustomerUpload(prisma, UPLOADS_DIR, id, file, 'image', 'contacts')
    await commitNewUpload(written.filename, async () => {
      if (typeof contactId === 'string') {
        const updated = contacts.map(contact => contact.id === contactId ? { ...contact, cardUrl: written.url } : contact)
        const result = await prisma.customer.updateMany({
          where: { id, contactsJson: customer.contactsJson },
          data: { contactsJson: JSON.stringify(updated) },
        })
        requireMetadataUpdate(result.count)
      } else {
        const result = await prisma.customer.updateMany({
          where: { id, mainContactCardUrl: customer.mainContactCardUrl },
          data: { mainContactCardUrl: written.url },
        })
        requireMetadataUpdate(result.count)
      }
    })

    const cleanupWarning = await cleanupOld(id, target?.cardUrl ?? (contactId === null ? customer.mainContactCardUrl : null))
    return NextResponse.json({ url: written.url, ...(cleanupWarning && { cleanupWarning }) })
  } catch (error) {
    return failure(error)
  }
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  try {
    const contactId = req.nextUrl.searchParams.get('contactId')
    const customer = await prisma.customer.findUnique({ where: { id } })
    if (!customer) return NextResponse.json({ error: 'Not found' }, { status: 404 })

    let oldUrl: string | null
    let nextContactsJson: string | undefined
    if (contactId) {
      const contacts = parseContacts(customer.contactsJson)
      const target = contacts.find(contact => contact.id === contactId)
      if (!target) return NextResponse.json({ error: 'Contact not found' }, { status: 404 })
      oldUrl = target.cardUrl
      const updated = contacts.map(contact => contact.id === contactId ? { ...contact, cardUrl: null } : contact)
      nextContactsJson = JSON.stringify(updated)
    } else {
      oldUrl = customer.mainContactCardUrl
    }

    await deleteOwnedUpload(UPLOADS_DIR, id, oldUrl, async () => {
      const result = contactId
        ? await prisma.customer.updateMany({
            where: { id, contactsJson: customer.contactsJson },
            data: { contactsJson: nextContactsJson },
          })
        : await prisma.customer.updateMany({
            where: { id, mainContactCardUrl: customer.mainContactCardUrl },
            data: { mainContactCardUrl: null },
          })
      requireMetadataUpdate(result.count)
    }, async () => {
      const restored = contactId
        ? await prisma.customer.updateMany({
            where: { id, contactsJson: nextContactsJson },
            data: { contactsJson: customer.contactsJson },
          })
        : await prisma.customer.updateMany({
            where: { id, mainContactCardUrl: null },
            data: { mainContactCardUrl: customer.mainContactCardUrl },
          })
      requireMetadataUpdate(restored.count)
    })
    return NextResponse.json({ ok: true })
  } catch (error) {
    return failure(error)
  }
}
