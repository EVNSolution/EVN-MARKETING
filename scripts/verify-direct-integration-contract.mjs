import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'

const METHODS = 'GET|POST|PUT|PATCH|DELETE'
const root = process.cwd()
const repository = process.argv[2]
const manifestNames = repository === 'evn-marketing'
  ? ['WARP_MARKETING_INQUIRIES.json']
  : ['WARP_BUILDUP_DIRECT_API.json', 'WARP_MARKETING_INQUIRIES.json']

function fail(message) {
  throw new Error(`Direct integration contract: ${message}`)
}

async function filesUnder(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  const files = []
  for (const entry of entries) {
    const absolute = path.join(directory, entry.name)
    if (entry.isDirectory()) files.push(...await filesUnder(absolute))
    else files.push(absolute)
  }
  return files
}

function signature(endpoint) {
  return `${endpoint.method} ${endpoint.path}`
}

async function nextRoutes(config) {
  const routeRoot = path.join(root, config.route_root)
  const routeFiles = (await filesUnder(routeRoot)).filter(file => file.endsWith('/route.ts'))
  const routes = []
  for (const file of routeFiles) {
    const source = await readFile(file, 'utf8')
    const relativeDirectory = path.dirname(path.relative(routeRoot, file))
    const suffix = relativeDirectory === '.' ? '' : `/${relativeDirectory}`
    const routePath = `${config.route_root.replace(/^app/, '')}${suffix}`
      .replace(/\[\.\.\.([^\]]+)\]/g, ':$1*')
      .replace(/\[([^\]]+)\]/g, ':$1')
    for (const match of source.matchAll(new RegExp(`export\\s+async\\s+function\\s+(${METHODS})\\b`, 'g'))) {
      routes.push(`${match[1]} ${routePath}`)
    }
  }
  return routes.sort()
}

async function expressRoutes(config) {
  const source = await readFile(path.join(root, config.route_file), 'utf8')
  const routes = []
  const pattern = /externalRouter\.(get|post|put|patch|delete)\(\s*['\"]([^'\"]+)['\"]/g
  for (const match of source.matchAll(pattern)) {
    routes.push(`${match[1].toUpperCase()} ${config.route_prefix}${match[2]}`)
  }
  return routes.sort()
}

async function verifySourceTokens(manifest) {
  for (const endpoint of manifest.endpoints) {
    const sourceRef = endpoint.sources?.[repository]
    if (!sourceRef) fail(`${endpoint.id} has no ${repository} source reference`)
    const source = await readFile(path.join(root, sourceRef.file), 'utf8').catch(() => null)
    if (source === null) fail(`${sourceRef.file} does not exist for ${endpoint.id}`)
    if (!source.includes(sourceRef.token)) fail(`${sourceRef.file} no longer contains the token for ${endpoint.id}`)
  }
}

async function verifyOutboundLiterals(manifest, config) {
  const providerFiles = new Set(
    manifest.endpoints
      .filter(endpoint => endpoint.provider === repository)
      .map(endpoint => endpoint.sources[repository].file),
  )
  const allowed = manifest.endpoints
    .filter(endpoint => endpoint.caller === repository)
    .map(endpoint => endpoint.sources[repository])

  for (const sourceRoot of config.source_roots) {
    const files = (await filesUnder(path.join(root, sourceRoot)))
      .filter(file => /\.(?:ts|tsx|js|mjs)$/.test(file))
    for (const file of files) {
      const relative = path.relative(root, file)
      if (providerFiles.has(relative) || /(?:^|\/)(__tests__)(?:\/|$)|\.(?:test|spec)\./.test(relative)) continue
      const source = await readFile(file, 'utf8')
      for (const match of source.matchAll(/(['"`])([^'"`\n]*\/api\/external\/[^'"`\n]*)\1/g)) {
        const literal = match[2]
        const declared = allowed.some(ref => ref.file === relative && literal.includes(ref.token))
        if (!declared) fail(`undeclared external API caller in ${relative}: ${literal}`)
      }
    }
  }
}

async function main() {
  const manifests = await Promise.all(manifestNames.map(async name =>
    JSON.parse(await readFile(path.join(root, 'docs/integrations', name), 'utf8'))))
  if (manifests.some(item => item.owner !== 'OziinG')) fail('owner must remain OziinG')
  const manifest = {
    owner: 'OziinG',
    repositories: Object.assign({}, ...manifests.map(item => item.repositories)),
    endpoints: manifests.flatMap(item => item.endpoints),
  }
  const config = manifest.repositories?.[repository]
  if (!repository || !config) fail(`unknown repository ${repository ?? '(missing)'}`)
  if (manifest.owner !== 'OziinG') fail('owner must remain OziinG')

  const signatures = manifest.endpoints.map(signature)
  if (new Set(signatures).size !== signatures.length) fail('duplicate method and path')

  await verifySourceTokens(manifest)
  const actual = config.route_style === 'caller-only' ? [] : config.route_style === 'next'
    ? await nextRoutes(config)
    : await expressRoutes(config)
  const declared = manifest.endpoints
    .filter(endpoint => endpoint.provider === repository)
    .map(signature)
    .sort()
  if (JSON.stringify(actual) !== JSON.stringify(declared)) {
    fail(`owned route drift\ndeclared=${JSON.stringify(declared)}\nactual=${JSON.stringify(actual)}`)
  }
  await verifyOutboundLiterals(manifest, config)
  console.log(`Verified ${manifest.endpoints.length} declared integration endpoints for ${repository}`)
}

await main()
