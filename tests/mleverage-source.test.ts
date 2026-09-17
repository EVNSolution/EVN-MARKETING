import assert from 'node:assert/strict'
import vm from 'node:vm'
import { automaticLogin, readSourcePage } from '@/workers/mleverage-source'

const values: Record<string, string> = {
  문의일자: '2026-09-15',
  문의시간: '09:30',
  상담상태: '접수',
  phoneNumber: '010-0000-0001',
}
const row = {
  querySelector: (selector: string) => ({ innerText: values[selector.match(/data-col-key="([^"]+)"/)?.[1] ?? ''] ?? '' }),
}
const cell = {
  id: '__cell_00000000-0000-4000-8000-000000000001_name',
  textContent: '합성 문의',
  parentElement: row,
}

function runSerialized(fn: (arg: unknown) => unknown, arg: unknown, context = {}) {
  return (vm.runInNewContext(`(${fn.toString()})`, context) as (value: unknown) => unknown)(arg)
}

function fakePage(finalTotal: 0 | 1, startsLoading = false) {
  let ready = !startsLoading
  const cells = () => finalTotal === 1 && ready ? [cell] : []
  const nameCells = {
    first: () => ({
      waitFor: () => finalTotal === 1
        ? Promise.resolve().then(() => { ready = true })
        : new Promise(() => {}),
    }),
    count: async () => cells().length,
    evaluateAll: async (fn: (arg: unknown) => unknown) => runSerialized(fn, cells()),
  }
  return {
    goto: async () => {},
    url: () => 'https://app.mleverage-admin.co.kr/inquiry-history',
    waitForFunction: async (fn: (arg: unknown) => unknown, arg: unknown) => {
      assert.equal(runSerialized(fn, arg, { document: { querySelectorAll: cells } }), true)
    },
    locator: (selector: string) => selector.includes('data-col-key="name"')
      ? nameCells
      : { isVisible: async () => false, waitFor: () => new Promise(() => {}) },
    getByText: () => ({
      waitFor: () => finalTotal === 0 ? Promise.resolve() : new Promise(() => {}),
      isVisible: async () => finalTotal === 0,
    }),
    getByRole: (_role: string, options: { name: string | RegExp }) => {
      if (options.name instanceof RegExp) return {
        waitFor: async () => {},
        count: async () => 1,
        textContent: async () => {
          if (startsLoading) assert.equal(ready, true, 'total read before rows were ready')
          return `총 ${ready ? finalTotal : 0}개`
        },
      }
      if (options.name === '200개씩') return { isVisible: async () => true }
      return { and: () => ({ count: async () => 1 }) }
    },
  }
}

function fakeLoginPage(initialUrl = 'https://app.mleverage-admin.co.kr/login', authenticates = true, redirectsAfterUsername = false) {
  let url = initialUrl
  const fills: string[] = []
  let clicks = 0
  let pendingWaits = 0
  let maxConcurrentWaits = 0
  let ready = false
  const waitFor = async () => {
    pendingWaits++
    maxConcurrentWaits = Math.max(maxConcurrentWaits, pendingWaits)
    await Promise.resolve()
    ready = true
    pendingWaits--
  }
  const field = {
    waitFor,
    count: async () => ready ? 1 : 0,
    fill: async (value: string) => {
      fills.push(value)
      if (redirectsAfterUsername && fills.length === 1) url = 'https://example.invalid/login'
    },
    and() { return this },
  }
  return {
    page: {
      url: () => url,
      getByRole: (role: string) => role === 'textbox'
        ? field
        : { waitFor, count: async () => ready ? 1 : 0, click: async () => { clicks++; if (authenticates) url = 'https://app.mleverage-admin.co.kr/' } },
      getByPlaceholder: () => field,
      locator: () => field,
      waitForURL: async (matches: (url: URL) => boolean) => {
        if (!matches(new URL(url))) throw new Error('synthetic authentication failure')
      },
    },
    fills,
    clicks: () => clicks,
    maxConcurrentWaits: () => maxConcurrentWaits,
  }
}

async function main() {
  const authenticated = fakeLoginPage()
  assert.equal(await automaticLogin(authenticated.page as never, { username: 'synthetic-user', password: 'synthetic-password' }), true)
  assert.deepEqual(authenticated.fills, ['synthetic-user', 'synthetic-password'])
  assert.equal(authenticated.clicks(), 1)
  assert.equal(authenticated.maxConcurrentWaits(), 3, 'login controls wait for hydration concurrently')

  const rejected = fakeLoginPage(undefined, false)
  assert.equal(await automaticLogin(rejected.page as never, { username: 'synthetic-user', password: 'wrong-synthetic-password' }), false)
  assert.equal(rejected.clicks(), 1)

  const untrusted = fakeLoginPage('https://example.invalid/login')
  assert.equal(await automaticLogin(untrusted.page as never, { username: 'must-not-fill', password: 'must-not-fill' }), false)
  assert.deepEqual(untrusted.fills, [])
  assert.equal(untrusted.clicks(), 0)

  const redirected = fakeLoginPage(undefined, true, true)
  assert.equal(await automaticLogin(redirected.page as never, { username: 'synthetic-user', password: 'must-not-fill' }), false)
  assert.deepEqual(redirected.fills, ['synthetic-user'])
  assert.equal(redirected.clicks(), 0)

  const loading = await readSourcePage(fakePage(1, true) as never, '2026-09-15', '2026-09-15', 1)
  assert.equal(loading.total, 1)
  assert.equal(loading.rows.length, 1)
  assert.equal(loading.rows[0].sourceId, '00000000-0000-4000-8000-000000000001')
  assert.equal(loading.rows[0].phone, values.phoneNumber)

  const empty = await readSourcePage(fakePage(0) as never, '2026-09-15', '2026-09-15', 1)
  assert.deepEqual(empty, { page: 1, total: 0, rows: [] })

  const existing = await readSourcePage(fakePage(1) as never, '2026-09-15', '2026-09-15', 1)
  assert.equal(existing.rows.length, 1)
  console.log('mleverage source readiness tests passed')
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
