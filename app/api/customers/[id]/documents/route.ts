import { NextRequest, NextResponse } from 'next/server'
import path from 'node:path'
import { prisma } from '@/lib/db'
import {
  type DocMeta,
  commitNewUpload,
  deleteOwnedUpload,
  parseDocuments,
  removeOwnedUpload,
  requireMetadataUpdate,
  validateMultipartLength,
  writeCustomerUpload,
} from '@/lib/upload-security'

const UPLOADS_DIR = process.env.UPLOADS_DIR ?? path.join(process.cwd(), 'uploads')
const DOCUMENT_TYPES = new Set(['사업자등록증', '계좌정보', '차량사진'])

function failure(error: unknown) {
  const allowed: Record<string, number> = {
    invalid_upload_size: 413, customer_upload_quota_exceeded: 413, invalid_upload_type: 415,
    invalid_documents_metadata: 409, invalid_upload_path: 409, invalid_customer_path: 409,
    upload_metadata_changed: 409, upload_length_required: 411,
    old_upload_cleanup_failed: 500, delete_rollback_failed: 500,
    database_update_failed_and_new_upload_cleanup_failed: 500,
    partial_upload_cleanup_failed: 500, upload_write_failed: 500,
  }
  const message = error instanceof Error ? error.message : ''
  const code = Object.hasOwn(allowed, message) ? message : 'upload_failed'
  const status = allowed[code] ?? 500
  const description = status === 413 ? '파일은 10MB 이하, 고객별 첨부파일은 총 50MB 이하로 올려주세요.'
    : status === 415 ? '지원되는 이미지 또는 PDF 파일인지 확인해 주세요. 차량 사진은 이미지로 올려주세요.'
      : status === 409 ? '첨부파일 정보가 변경되었거나 올바르지 않습니다. 새로고침 후 확인해 주세요.'
        : status === 411 ? '파일 전송 정보를 확인하지 못했습니다. 파일을 다시 선택해 주세요.'
          : '파일 처리를 완료하지 못했습니다. 다시 확인하고 문제가 계속되면 관리자에게 알려주세요.'
  return NextResponse.json({ error: description, code }, { status })
}

async function cleanupOld(customerId: string, url?: string) {
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

    const docs = parseDocuments(customer.documentsJson)
    const form = await req.formData()
    const file = form.get('file')
    const docType = form.get('type')
    if (!(file instanceof File) || typeof docType !== 'string' || !DOCUMENT_TYPES.has(docType)) {
      return NextResponse.json({ error: 'Invalid file or type' }, { status: 400 })
    }

    const old = docs.find(doc => doc.type === docType)
    const written = await writeCustomerUpload(UPLOADS_DIR, id, file, docType === '차량사진' ? 'image' : 'document')
    const doc: DocMeta = {
      type: docType,
      name: file.name,
      path: written.url,
      size: file.size,
      uploadedAt: new Date().toISOString(),
    }
    const updated = [...docs.filter(item => item.type !== docType), doc]
    await commitNewUpload(written.filename, async () => {
      const result = await prisma.customer.updateMany({
        where: { id, documentsJson: customer.documentsJson },
        data: { documentsJson: JSON.stringify(updated) },
      })
      requireMetadataUpdate(result.count)
    })

    const cleanupWarning = await cleanupOld(id, old?.path)
    return NextResponse.json({ doc, ...(cleanupWarning && { cleanupWarning }) })
  } catch (error) {
    return failure(error)
  }
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const docType = req.nextUrl.searchParams.get('type')
  if (!docType || !DOCUMENT_TYPES.has(docType)) return NextResponse.json({ error: 'Invalid type' }, { status: 400 })

  try {
    const customer = await prisma.customer.findUnique({ where: { id } })
    if (!customer) return NextResponse.json({ error: 'Not found' }, { status: 404 })
    const docs = parseDocuments(customer.documentsJson)
    const target = docs.find(doc => doc.type === docType)
    if (!target) return NextResponse.json({ error: 'Document not found' }, { status: 404 })

    const updatedJson = JSON.stringify(docs.filter(doc => doc.type !== docType))
    await deleteOwnedUpload(UPLOADS_DIR, id, target.path, async () => {
      const result = await prisma.customer.updateMany({
        where: { id, documentsJson: customer.documentsJson },
        data: { documentsJson: updatedJson },
      })
      requireMetadataUpdate(result.count)
    }, async () => {
      const restored = await prisma.customer.updateMany({
        where: { id, documentsJson: updatedJson },
        data: { documentsJson: customer.documentsJson },
      })
      requireMetadataUpdate(restored.count)
    })
    return NextResponse.json({ ok: true })
  } catch (error) {
    return failure(error)
  }
}
