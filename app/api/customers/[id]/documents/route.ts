import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import path from 'path'
import fs from 'fs/promises'

const UPLOADS_DIR = process.env.UPLOADS_DIR ?? path.join(process.cwd(), 'uploads')

type DocMeta = { type: string; name: string; path: string; size: number; uploadedAt: string }

function getDocs(customer: { documentsJson: string | null }): DocMeta[] {
  if (!customer.documentsJson) return []
  try { return JSON.parse(customer.documentsJson) } catch { return [] }
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params

  const customer = await prisma.customer.findUnique({ where: { id } })
  if (!customer) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const form = await req.formData()
  const file = form.get('file') as File | null
  const docType = form.get('type') as string | null
  if (!file || !docType) return NextResponse.json({ error: 'Missing file or type' }, { status: 400 })

  const uploadDir = path.join(UPLOADS_DIR, 'customers', id)
  await fs.mkdir(uploadDir, { recursive: true })

  const safeName = `${Date.now()}_${file.name.replace(/[^\w.\-]/g, '_')}`
  const absPath  = path.join(uploadDir, safeName)
  await fs.writeFile(absPath, Buffer.from(await file.arrayBuffer()))

  const docs = getDocs(customer).filter(d => d.type !== docType)
  const doc: DocMeta = {
    type: docType,
    name: file.name,
    path: `/api/uploads/customers/${id}/${safeName}`,
    size: file.size,
    uploadedAt: new Date().toISOString(),
  }
  docs.push(doc)

  await prisma.customer.update({ where: { id }, data: { documentsJson: JSON.stringify(docs) } })
  return NextResponse.json({ doc })
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const docType = req.nextUrl.searchParams.get('type')
  if (!docType) return NextResponse.json({ error: 'Missing type' }, { status: 400 })

  const customer = await prisma.customer.findUnique({ where: { id } })
  if (!customer) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const docs = getDocs(customer)
  const target = docs.find(d => d.type === docType)

  if (target) {
    const relPath = target.path.startsWith('/api/uploads/')
      ? target.path.slice('/api/uploads/'.length)
      : null
    const absPath = relPath
      ? path.join(/* turbopackIgnore: true */ UPLOADS_DIR, relPath)
      : path.join(process.cwd(), 'public', target.path)
    await fs.unlink(absPath).catch(() => {})
  }

  const updated = docs.filter(d => d.type !== docType)
  await prisma.customer.update({ where: { id }, data: { documentsJson: JSON.stringify(updated) } })
  return NextResponse.json({ ok: true })
}
