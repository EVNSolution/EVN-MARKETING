import 'dotenv/config'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import bcrypt from 'bcryptjs'
import { createClient } from '@libsql/client'
import { PrismaLibSql } from '@prisma/adapter-libsql'
import { PrismaClient } from '@/app/generated/prisma/client'
import {
  INQUIRY_COMPANY_ID,
  INQUIRY_HOMEPAGE_ID,
  INQUIRY_SCOPE_ID,
  INQUIRY_SOURCE,
} from '@/lib/inquiry-sync'

async function main() {
  const databaseUrl = process.env.PREVIEW_DATABASE_URL?.trim()
  const adminPassword = process.env.PREVIEW_ADMIN_PASSWORD
  const userPassword = process.env.PREVIEW_USER_PASSWORD
  if (!databaseUrl?.startsWith('file:/tmp/') || !adminPassword || !userPassword) throw new Error('invalid_preview_config')
  const databasePath = databaseUrl.slice('file:'.length)
  if (existsSync(databasePath)) throw new Error('preview_database_exists')

  const sql = createClient({ url: databaseUrl })
  await sql.executeMultiple(await readFile(path.join(process.cwd(), 'prisma/migrations/20260915000100_baseline/migration.sql'), 'utf8'))
  await sql.executeMultiple(await readFile(path.join(process.cwd(), 'prisma/migrations/20260915000200_inquiry_sync/migration.sql'), 'utf8'))
  await sql.executeMultiple(await readFile(path.join(process.cwd(), 'prisma/migrations/20260915000300_warp_delivery/migration.sql'), 'utf8'))
  await sql.close()

  const prisma = new PrismaClient({ adapter: new PrismaLibSql({ url: databaseUrl }) })
  const now = new Date()
  await prisma.user.createMany({ data: [
    { id: 'preview-admin', name: '합성 관리자', email: 'preview-admin@example.invalid', password: await bcrypt.hash(adminPassword, 10), role: 'admin', updatedAt: now },
    { id: 'preview-user', name: '합성 사용자', email: 'preview-user@example.invalid', password: await bcrypt.hash(userPassword, 10), role: 'user', updatedAt: now },
  ] })
  await prisma.inquiry.createMany({
    data: Array.from({ length: 43 }, (_, index) => ({
      source: INQUIRY_SOURCE,
      companyScopeId: INQUIRY_COMPANY_ID,
      homepageScopeId: INQUIRY_HOMEPAGE_ID,
      sourceId: `10000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
      inquiryDate: `2026-09-${String(15 - Math.floor(index / 6)).padStart(2, '0')}`,
      inquiryTime: `${String(9 + index % 10).padStart(2, '0')}:${String(index % 60).padStart(2, '0')}`,
      sourceStatus: index % 5 === 0 ? null : ['접수', '관리중', '없는 번호', '부재중(5회이상)'][index % 4],
      name: index % 3 === 0 ? null : `합성 문의 ${index + 1}`,
      phone: `010-0000-${String(index).padStart(4, '0')}`,
      firstSeenAt: now,
      lastSeenAt: now,
    })),
  })
  await prisma.inquirySyncState.create({
    data: {
      id: INQUIRY_SCOPE_ID,
      source: INQUIRY_SOURCE,
      companyScopeId: INQUIRY_COMPANY_ID,
      homepageScopeId: INQUIRY_HOMEPAGE_ID,
      status: 'success',
      lastSuccessfulAt: now,
      nextRunAt: new Date(now.getTime() + 60 * 60_000),
    },
  })
  await prisma.$disconnect()
  console.log('preview database ready')
}

main().catch(() => {
  console.error('preview_setup_failed')
  process.exitCode = 1
})
