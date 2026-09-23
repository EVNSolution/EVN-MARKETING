import { NextRequest } from 'next/server'
import path from 'node:path'
import { auth } from '@/auth'
import { uploadResponse } from '@/lib/upload-security'

const UPLOADS_DIR = process.env.UPLOADS_DIR ?? path.join(process.cwd(), 'uploads')

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ path: string[] }> },
) {
  const [session, { path: segments }] = await Promise.all([auth(), params])
  return uploadResponse(UPLOADS_DIR, segments, !!session)
}
