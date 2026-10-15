import { NextResponse } from 'next/server'
import { auth } from '@/auth'
import { prisma } from '@/lib/db'
import { manualSyncError } from '@/lib/inquiry-sync'
import { NameReviewError, readNameJob, requestNameJob } from '@/lib/warp-customer-name'

type Context = { params: Promise<{ id: string }> }
const idValid = (id: unknown): id is string => typeof id === 'string' && /^[A-Za-z0-9_-]{1,160}$/.test(id)
const jobValid = (id: unknown): id is string => typeof id === 'string' && /^[0-9a-f-]{36}$/.test(id)
const reply = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: { 'Cache-Control': 'no-store' } })
const failure = (error: unknown) => reply({ error: error instanceof NameReviewError ? error.message : '이름 보완 요청을 처리하지 못했습니다. 잠시 후 다시 확인해 주세요.' }, error instanceof NameReviewError ? error.status : 503)

export async function GET(request: Request, context: Context) {
  const session = await auth()
  if (!session?.user) return reply({ error: '로그인이 필요합니다.' }, 401)
  if (session.user.role !== 'admin') return reply({ error: '관리자만 이름을 보완할 수 있습니다.' }, 403)
  const { id } = await context.params, jobId = new URL(request.url).searchParams.get('job')
  if (!idValid(id) || !jobValid(jobId)) return reply({ error: '이름 확인 요청을 확인해 주세요.' }, 400)
  try { return reply(await readNameJob(prisma, id, jobId, session.user.id)) } catch (error) { return failure(error) }
}

export async function POST(request: Request, context: Context) {
  const session = await auth()
  const denied = manualSyncError(session?.user.role, request.url, request.headers.get('origin'),
    request.headers.get('x-forwarded-host') ?? request.headers.get('host'), request.headers.get('x-forwarded-proto'))
  if (denied || !session?.user) return reply({ error: denied === 401 ? '로그인이 필요합니다.' : denied === 403 ? '관리자만 이름을 보완할 수 있습니다.' : '잘못된 요청입니다.' }, denied ?? 401)
  const { id } = await context.params
  if (!idValid(id)) return reply({ error: '문의를 확인해 주세요.' }, 400)
  let body: Record<string, unknown>
  try {
    const reader = request.body?.getReader()
    if (!reader) throw new Error()
    const chunks: Uint8Array[] = []; let size = 0
    while (true) {
      const { done, value } = await reader.read(); if (done) break
      size += value.length
      if (size > 2048) { await reader.cancel(); throw new Error() }
      chunks.push(value)
    }
    body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error()
  } catch { return reply({ error: '이름 확인 요청을 확인해 주세요.' }, 400) }
  const keys = body.action === 'confirm' ? ['action', 'candidateId', 'reviewToken', 'jobId'] : ['action', 'candidateId', 'reviewToken']
  if (!['preview', 'confirm'].includes(String(body.action)) || Object.keys(body).length !== keys.length
    || Object.keys(body).some(key => !keys.includes(key)) || !idValid(body.candidateId)
    || typeof body.reviewToken !== 'string' || !/^[a-f0-9]{64}$/.test(body.reviewToken)
    || (body.action === 'confirm' && !jobValid(body.jobId))) return reply({ error: '이름 확인 요청을 확인해 주세요.' }, 400)
  try {
    const result = await requestNameJob(prisma, id, { action: body.action as 'preview' | 'confirm',
      candidateId: body.candidateId, reviewToken: body.reviewToken, jobId: body.jobId as string | undefined },
    { id: session.user.id, name: session.user.name || session.user.id })
    return reply(result, ['preview', 'confirm'].includes(result.phase) ? 202 : 200)
  } catch (error) { return failure(error) }
}
