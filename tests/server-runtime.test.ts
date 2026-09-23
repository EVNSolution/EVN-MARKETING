import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { browserHeadless } from '@/workers/mleverage-source'
import { readSourceCredentials } from '@/workers/source-credentials'

async function main() {
  assert.deepEqual(await readSourceCredentials({ MLEVERAGE_USERNAME: ' user ', MLEVERAGE_PASSWORD: ' secret ' }, 'linux'), {
    username: 'user', password: ' secret ',
  })
  await assert.rejects(readSourceCredentials({ MLEVERAGE_USERNAME: 'user' }, 'linux'), /source_credentials_incomplete/)
  await assert.rejects(readSourceCredentials({ MLEVERAGE_PASSWORD: 'secret' }, 'darwin'), /source_credentials_incomplete/)
  await assert.rejects(readSourceCredentials({ MLEVERAGE_USERNAME: '' }, 'darwin'), /source_credentials_incomplete/)
  await assert.rejects(readSourceCredentials({}, 'linux'), /source_credentials_missing/)
  assert.equal(browserHeadless(undefined, 'linux'), true)
  assert.equal(browserHeadless(undefined, 'darwin'), false)
  assert.equal(browserHeadless('false', 'linux'), false)
  assert.equal(browserHeadless('true', 'darwin'), true)
  assert.throws(() => browserHeadless('yes', 'linux'), /invalid_INQUIRY_BROWSER_HEADLESS/)
  const compose = readFileSync('docker-compose.yml', 'utf8')
  const dockerignore = readFileSync('.dockerignore', 'utf8')
  const dockerfile = readFileSync('Dockerfile', 'utf8')
  assert.match(compose, /127\.0\.0\.1:3100:3000/)
  assert.match(compose, /profiles: \[collector\]/)
  assert.match(compose, /WARP_DELIVERY_ENABLED: \$\{WARP_DELIVERY_ENABLED:-false\}/)
  assert.match(dockerfile, /--format=esm --packages=external --outfile=worker\.mjs/)
  assert.match(dockerfile, /COPY scripts\/warp-delivery\.ts scripts\/warp-delivery\.ts/)
  assert.match(dockerfile, /esbuild scripts\/warp-delivery\.ts --bundle --platform=node --format=esm --packages=external --outfile=warp-delivery\.mjs/)
  assert.match(dockerfile, /COPY --from=build \/app\/warp-delivery\.mjs \.\/warp-delivery\.mjs/)
  assert.match(dockerfile, /USER node/)
  assert.doesNotMatch(dockerfile, /COPY --from=build \/app\/node_modules \.\/node_modules/)
  assert.match(dockerignore, /^\*\*\s*$/m)
  assert.match(dockerignore, /^\*\*\/\.env\*$/m)
  assert.match(dockerignore, /^!scripts\/$/m)
  assert.match(dockerignore, /^!scripts\/warp-delivery\.ts$/m)
  assert.doesNotMatch(dockerignore, /^!scripts\/\*\*$/m)
  console.log('server runtime checks passed')
}

main().catch(() => { process.exitCode = 1 })
