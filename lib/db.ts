import path from 'path'
import { PrismaClient } from '@/app/generated/prisma/client'
import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3'

const globalForPrisma = globalThis as unknown as { prisma: PrismaClient }

type DatabaseEnvironment = {
  DATABASE_URL?: string
  NODE_ENV?: string
}

export function resolveDatabaseUrl(env: DatabaseEnvironment = process.env) {
  const configured = env.DATABASE_URL?.trim()
  if (configured) return configured
  if (env.NODE_ENV === 'production') {
    throw new Error('DATABASE_URL must be set in production')
  }
  return `file:${path.resolve(process.cwd(), 'dev.db')}`
}

export function createPrisma(databaseUrl?: string) {
  const url = databaseUrl ?? resolveDatabaseUrl()
  const adapter = new PrismaBetterSqlite3({ url, timeout: 5000 }, { timestampFormat: 'iso8601' })
  if (url.startsWith('file:')) {
    const connect = adapter.connect.bind(adapter)
    adapter.connect = async () => {
      const connection = await connect()
      try {
        // Finish setup before queries: rollback journaling lets app readers block worker commits.
        await connection.executeScript('PRAGMA journal_mode = WAL')
        return connection
      } catch (error) {
        await connection.dispose()
        throw error
      }
    }
  }
  return new PrismaClient({ adapter })
}

export const prisma = globalForPrisma.prisma ?? createPrisma()

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma
