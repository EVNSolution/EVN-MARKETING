import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3'
import { LANDING_POLICY_VERSION, landingScope, landingOrigin, parseLandingInput, saveLandingInquiry, closeLandingInquiry, handleLandingRequest } from '@/lib/landing-inquiries'

const secret = 'synthetic-secret-for-tests-only-000000000'
const form = (id: string = randomUUID()) => ({ submissionId: id, name: '합성 상담', phone: '010-0000-0000', kind: 'consultation', consent: true, policyVersion: LANDING_POLICY_VERSION })

async function main() {
  if (process.argv[2] === '--race') {
    process.env.DATABASE_URL = process.argv[3]
    const { prisma } = await import('@/lib/db')
    try {
      const input = parseLandingInput(form(process.argv[4]))!
      assert.equal((await saveLandingInquiry(prisma, input, secret)).status, 'saved')
    } finally { await prisma.$disconnect() }
    return
  }
  const directory = await mkdtemp(path.join(tmpdir(), 'evn-landing-synthetic-'))
  const url = `file:${path.join(directory, 'test.db')}`
  process.env.DATABASE_URL = url
  const connection = await new PrismaBetterSqlite3({ url }).connect()
  try {
    const root = path.join(process.cwd(), 'prisma/migrations')
    for (const name of (await readdir(root)).filter(name => /^\d{14}_/.test(name)).sort()) await connection.executeScript(await readFile(path.join(root, name, 'migration.sql'), 'utf8'))
  } finally { await connection.dispose() }
  const { prisma } = await import('@/lib/db')
  const env = { LANDING_INTAKE_ENABLED: 'true', AUTH_URL: 'https://marketing.example', AUTH_SECRET: secret, NODE_ENV: 'production' }
  const request = (body: unknown, extra: Record<string, string> = {}) => new Request('https://marketing.example/api/external/landing-inquiries', { method: 'POST', headers: { origin: env.AUTH_URL, 'content-type': 'application/json', ...extra }, body: typeof body === 'string' ? body : JSON.stringify(body) })
  try {
    assert.equal(landingOrigin({ ...env, LANDING_INTAKE_ENABLED: 'false' }), null)
    assert.equal(landingOrigin({ ...env, AUTH_URL: 'http://127.0.0.1:3021' }), null)
    assert.equal((await handleLandingRequest(request(form()), prisma, { ...env, LANDING_INTAKE_ENABLED: 'false' })).status, 503)
    assert.equal((await handleLandingRequest(request(form(), { origin: 'https://attacker.example' }), prisma, env)).status, 403)
    assert.equal((await handleLandingRequest(request(form(), { 'content-type': 'text/plain' }), prisma, env)).status, 415)
    assert.equal((await handleLandingRequest(request('x'.repeat(4097)), prisma, env)).status, 413)
    for (const body of [null, [], {}, { ...form(), name: {} }, { ...form(), consent: false }, { ...form(), phone: '0101234567' }, { ...form(), policyVersion: 'old' }, { ...form(), kind: ['consultation'] }, { ...form(), kind: 'subsidy', region: ['서울'] }, { ...form(), kind: 'subsidy', region: '' }, { ...form(), website: 'spam' }]) {
      assert.equal((await handleLandingRequest(request(body), prisma, env)).status, 400)
    }
    assert.equal(await prisma.inquiry.count(), 0)
    const id = randomUUID(), input = parseLandingInput(form(id))!
    const first = await handleLandingRequest(request(form(id)), prisma, env)
    assert.equal(first.status, 200)
    assert.deepEqual(await first.json(), { ok: true, receipt: id })
    assert.equal(first.headers.get('cache-control'), 'no-store')
    const results = await Promise.all(Array.from({ length: 12 }, () => saveLandingInquiry(prisma, input, secret)))
    assert.ok(results.every(result => result.status === 'saved'))
    assert.equal(await prisma.inquiry.count({ where: landingScope }), 1)
    assert.equal(await prisma.customer.count(), 0, 'the intake must not create customers')
    assert.equal((await saveLandingInquiry(prisma, { ...input, name: '다른 요청' }, secret)).status, 'conflict')
    const stored = await prisma.inquiry.findFirstOrThrow({ where: landingScope, include: { landingReceipt: true } })
    assert.equal(stored.phone, '01000000000')
    assert.equal(stored.landingReceipt?.consentVersion, LANDING_POLICY_VERSION)
    assert.ok(stored.landingReceipt?.consentedAt)
    assert.equal(stored.warpDeliveredAt, null)
    assert.equal(stored.warpError, null)

    const raceId = randomUUID()
    const child = () => new Promise<void>((resolve, reject) => {
      const tsconfig = process.env.TSX_TSCONFIG_PATH
      const args = [path.resolve('node_modules/tsx/dist/cli.mjs'), ...(tsconfig ? ['--tsconfig', tsconfig] : []), path.resolve('tests/landing-inquiries.test.ts'), '--race', url, raceId]
      const processChild = spawn(process.execPath, args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] })
      let stderr = ''
      processChild.stderr.on('data', chunk => { stderr += chunk })
      processChild.once('error', reject)
      processChild.once('exit', code => code === 0 ? resolve() : reject(new Error(stderr)))
    })
    await Promise.all([child(), child(), child()])
    assert.equal(await prisma.inquiry.count({ where: { ...landingScope, sourceId: raceId } }), 1, 'independent processes must share the writer lock')
    for (let index = 0; index < 3; index++) assert.equal((await saveLandingInquiry(prisma, parseLandingInput(form())!, secret)).status, 'saved')
    assert.equal((await saveLandingInquiry(prisma, parseLandingInput(form())!, secret)).status, 'limited')
    // Retry remains safe even after this phone reaches the throttle limit.
    assert.equal((await saveLandingInquiry(prisma, input, secret)).status, 'saved')
    const other = await prisma.inquiry.create({ data: { source: 'unrelated', companyScopeId: 'other', homepageScopeId: 'other', sourceId: randomUUID(), phone: 'synthetic', inquiryDate: '2026-10-07', inquiryTime: '10:00', lastSeenAt: new Date() } })
    assert.equal(await closeLandingInquiry(prisma, other.id, secret), false)
    assert.equal(await closeLandingInquiry(prisma, stored.id, secret), true)
    assert.equal(await prisma.inquiry.findUnique({ where: { id: stored.id } }), null)
    const receipt = await prisma.landingReceipt.findUniqueOrThrow({ where: { id } })
    for (const field of ['inquiryId', 'fingerprint', 'kind', 'region', 'consentVersion', 'consentedAt'] as const) assert.equal(receipt[field], null)
    assert.ok(receipt.closedAt)
    assert.equal((await saveLandingInquiry(prisma, input, secret)).status, 'closed')
    assert.equal(await prisma.inquiry.count({ where: { id: other.id } }), 1)
    console.log('PASS: validation, consent, durable receipt, 12 retries, 3-process race, throttling, no customer/WARP writes, closure isolation')
  } finally {
    await prisma.$disconnect()
    await rm(directory, { recursive: true, force: true })
  }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
