import { lstat, readFile } from 'node:fs/promises'
import path from 'node:path'

// The host opens this per-owner gate only after source login and health succeed.
export async function workerActivationAllowed(env: Readonly<Record<string, string | undefined>> = process.env) {
  const gate = env.MARKETING_WORKER_GATE
  if (gate === undefined) return true // Existing local worker keeps its explicit collector opt-in.
  if (!path.isAbsolute(gate) || path.normalize(gate) !== gate) throw new Error('invalid_worker_gate')
  try {
    const stat = await lstat(gate)
    return stat.isFile() && stat.size === 7 && await readFile(gate, 'utf8') === 'active\n'
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw new Error('worker_gate_unavailable')
  }
}
