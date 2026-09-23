import { PrismaClient } from '../app/generated/prisma/client'
import { PrismaLibSql } from '@prisma/adapter-libsql'
import path from 'path'
import bcrypt from 'bcryptjs'

const dbPath = path.resolve(process.cwd(), 'dev.db')
const adapter = new PrismaLibSql({ url: `file:${dbPath}` })
const prisma = new PrismaClient({ adapter })

async function main() {
  const team = await prisma.team.upsert({
    where: { id: 'team-mkt' },
    update: {},
    create: { id: 'team-mkt', name: '마케팅팀' },
  })

  const password = await bcrypt.hash('changeme123', 12)
  const user = await prisma.user.upsert({
    where: { email: 'admin@evnsolution.com' },
    update: {},
    create: {
      name: '관리자',
      email: 'admin@evnsolution.com',
      password,
      role: 'admin',
      teamId: team.id,
    },
  })

  console.log('시드 완료:', team.name, user.email)
}

main()
  .catch(e => {
    console.error(e)
    process.exit(1)
  })
  .finally(() => prisma.$disconnect())
