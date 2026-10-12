// Derive the migration toolchain from the repository lock; never resolve new versions.
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
const read = path => JSON.parse(readFileSync(path, 'utf8'))
if (process.argv[2] === 'prepare') {
  const pkg = read('package.json'), lock = read('package-lock.json')
  writeFileSync('migration-lock.json', JSON.stringify(lock))
  pkg.dependencies = Object.fromEntries(['prisma', 'dotenv', 'better-sqlite3']
    .map(name => [name, lock.packages[`node_modules/${name}`].version]))
  delete pkg.devDependencies
  writeFileSync('package.json', JSON.stringify(pkg))
} else if (process.argv[2] === 'verify') {
  const before = read('migration-lock.json'), after = read('package-lock.json')
  for (const [path, pkg] of Object.entries(after.packages)) {
    if (!path) continue
    assert.ok(before.packages[path], `unlocked migration dependency: ${path}`)
    for (const key of ['version', 'resolved', 'integrity']) {
      assert.equal(pkg[key], before.packages[path]?.[key], `migration dependency changed: ${path} ${key}`)
    }
  }
  for (const name of ['prisma', 'dotenv', 'better-sqlite3']) {
    assert.equal(read(`node_modules/${name}/package.json`).version, before.packages[`node_modules/${name}`].version)
  }
} else {
  throw new Error('expected prepare or verify')
}
