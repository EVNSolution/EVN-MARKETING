import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const root = process.cwd()
const require = createRequire(import.meta.url)

async function main() {
  // Keep external runtime packages resolvable, and run children away from any .env.
  const temp = await mkdtemp(path.join(root, '.warp-cli-test-'))
  try {
    const source = path.join(root, 'scripts/warp-delivery.ts')
    const bundle = path.join(temp, 'warp-delivery.mjs')
    await build({ entryPoints: [source], bundle: true, platform: 'node', format: 'esm', packages: 'external', outfile: bundle })
    const env: NodeJS.ProcessEnv = {
      NODE_ENV: 'production',
      DOTENV_CONFIG_PATH: path.join(temp, 'absent.env'),
      TSX_TSCONFIG_PATH: path.join(root, 'tsconfig.json'),
      WARP_DELIVERY_ENABLED: 'true',
    }
    const usages = 'usage: node warp-delivery.mjs check|pilot\nusage: npm run warp:delivery -- check|pilot'
    for (const entry of [source, bundle]) {
      const loader = entry === source ? ['--import', pathToFileURL(require.resolve('tsx')).href] : []
      // No endpoint override: any accidental fetch fails locally before making a request.
      const start = 'globalThis.fetch = () => { throw new Error("unexpected_network_access") }; import(process.argv[1])'
      const invoke = (args: string[], overrides: Record<string, string | undefined> = {}) => spawnSync(process.execPath, [
        ...loader, '--input-type=module', '--eval', start, pathToFileURL(entry).href, ...args,
      ], { cwd: temp, env: { ...env, ...overrides }, encoding: 'utf8', timeout: 10_000 })
      for (const mode of ['check', 'pilot']) {
        for (const key of [undefined, '', 'synthetic-short', ` ${'x'.repeat(32)}`, `${'x'.repeat(32)}\n`]) {
          for (const databaseUrl of [undefined, `file:${path.join(temp, 'must-not-open.db')}`]) {
            const result = invoke([mode], { WARP_MARKETING_API_KEY: key, DATABASE_URL: databaseUrl })
            assert.equal(result.status, 1, 'missing or invalid key fails closed')
            assert.equal(result.stderr, '', 'no raw exception, key or customer output')
            assert.equal(result.stdout.trim(), 'warp_key_required', 'key guard must precede production DB import')
          }
        }
      }
      for (const args of [[], ['unknown-synthetic-mode'], ['check', 'extra'], ['pilot', 'extra']]) {
        const result = invoke(args, { WARP_MARKETING_API_KEY: 'synthetic-test-key-never-used-in-production' })
        assert.equal(result.status, 1)
        assert.equal(result.stdout.trim(), usages, 'invalid arguments show both supported invocations before any I/O')
        assert.equal(result.stderr, '')
      }
      assert.deepEqual(await readdir(temp), ['warp-delivery.mjs'], 'CLI did not create a database or sidecars')
    }
    console.log('development and packaged WARP CLI: key guard, usage and no DB/network access passed')
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
