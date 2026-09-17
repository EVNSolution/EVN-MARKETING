import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import path from 'path'
import fs from 'fs/promises'

const UPLOADS_DIR = process.env.UPLOADS_DIR ?? path.join(process.cwd(), 'uploads')

type Contact = { id: string; name: string; phone: string; title: string; role: string; email: string; note: string; cardUrl: string | null }

function getContacts(customer: { contactsJson: string | null }): Contact[] {
  if (!customer.contactsJson) return []
  try { return JSON.parse(customer.contactsJson) } catch { return [] }
}

async function unlinkByPath(filePath: string) {
  const relPath = filePath.startsWith('/api/uploads/') ? filePath.slice('/api/uploads/'.length) : null
  const absPath = relPath
    ? path.join(/* turbopackIgnore: true */ UPLOADS_DIR, relPath)
    : path.join(process.cwd(), 'public', filePath)
  await fs.unlink(absPath).catch(() => {})
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params

  const customer = await prisma.customer.findUnique({ where: { id } })
  if (!customer) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const form      = await req.formData()
  const file      = form.get('file') as File | null
  const contactId = form.get('contactId') as string | null // 없으면 대표 거래처 담당자 명함
  if (!file) return NextResponse.json({ error: 'Missing file' }, { status: 400 })

  const uploadDir = path.join(UPLOADS_DIR, 'customers', id, 'contacts')
  await fs.mkdir(uploadDir, { recursive: true })

  const safeName = `${Date.now()}_${file.name.replace(/[^\w.\-]/g, '_')}`
  const absPath  = path.join(uploadDir, safeName)
  await fs.writeFile(absPath, Buffer.from(await file.arrayBuffer()))
  const url = `/api/uploads/customers/${id}/contacts/${safeName}`

  if (contactId) {
    const contacts = getContacts(customer)
    const target = contacts.find(c => c.id === contactId)
    if (target?.cardUrl) await unlinkByPath(target.cardUrl)
    const updated = contacts.map(c => c.id === contactId ? { ...c, cardUrl: url } : c)
    await prisma.customer.update({ where: { id }, data: { contactsJson: JSON.stringify(updated) } })
  } else {
    if (customer.mainContactCardUrl) await unlinkByPath(customer.mainContactCardUrl)
    await prisma.customer.update({ where: { id }, data: { mainContactCardUrl: url } })
  }

  return NextResponse.json({ url })
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const contactId = req.nextUrl.searchParams.get('contactId')

  const customer = await prisma.customer.findUnique({ where: { id } })
  if (!customer) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  if (contactId) {
    const contacts = getContacts(customer)
    const target = contacts.find(c => c.id === contactId)
    if (target?.cardUrl) await unlinkByPath(target.cardUrl)
    const updated = contacts.map(c => c.id === contactId ? { ...c, cardUrl: null } : c)
    await prisma.customer.update({ where: { id }, data: { contactsJson: JSON.stringify(updated) } })
  } else {
    if (customer.mainContactCardUrl) await unlinkByPath(customer.mainContactCardUrl)
    await prisma.customer.update({ where: { id }, data: { mainContactCardUrl: null } })
  }

  return NextResponse.json({ ok: true })
}
