import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)
const account = 'evnlogisitics'
const service = 'com.evnsolution.evn-marketing.mleverage'

export async function readSourceCredentials(
  env: { MLEVERAGE_USERNAME?: string, MLEVERAGE_PASSWORD?: string } = {
    MLEVERAGE_USERNAME: process.env.MLEVERAGE_USERNAME,
    MLEVERAGE_PASSWORD: process.env.MLEVERAGE_PASSWORD,
  },
  platform = process.platform,
) {
  const username = env.MLEVERAGE_USERNAME?.trim()
  const password = env.MLEVERAGE_PASSWORD
  if ((env.MLEVERAGE_USERNAME === undefined) !== (env.MLEVERAGE_PASSWORD === undefined)) {
    throw new Error('source_credentials_incomplete')
  }
  if (username || password) {
    if (!username || !password?.trim()) throw new Error('source_credentials_incomplete')
    return { username, password }
  }
  if (platform !== 'darwin') throw new Error('source_credentials_missing')
  try {
    const { stdout } = await run('/usr/bin/security', [
      'find-generic-password', '-a', account, '-s', service, '-w',
    ], { timeout: 5000, maxBuffer: 4096 })
    const password = stdout.replace(/\r?\n$/, '')
    return password ? { username: account, password } : null
  } catch {
    // Keychain may be locked or access denied. Never print its output or errors.
    return null
  }
}
