import assert from 'node:assert/strict'
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { workerActivationAllowed } from '../workers/worker-activation'

async function main() {
  const directory = await mkdtemp(path.join(tmpdir(), 'marketing-activation-'))
  const gate = path.join(directory, 'active')
  try {
    assert.equal(await workerActivationAllowed({}), true)
    await assert.rejects(workerActivationAllowed({ MARKETING_WORKER_GATE: '' }))
    await assert.rejects(workerActivationAllowed({ MARKETING_WORKER_GATE: 'relative' }))
    const env = { MARKETING_WORKER_GATE: gate }
    assert.equal(await workerActivationAllowed(env), false)
    await writeFile(gate, 'active\n')
    assert.equal(await workerActivationAllowed(env), true)
    await writeFile(gate, 'invalid')
    assert.equal(await workerActivationAllowed(env), false)
    await rm(gate)
    await writeFile(path.join(directory, 'other'), 'active\n')
    await symlink(path.join(directory, 'other'), gate)
    assert.equal(await workerActivationAllowed(env), false)
    console.log('worker activation: default, missing/invalid gate, explicit activation and symlink refusal passed')
  } finally { await rm(directory, { recursive: true, force: true }) }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
