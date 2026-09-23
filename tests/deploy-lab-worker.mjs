// Synthetic source worker for the isolated controller lab. No external network requests.
import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
const require = createRequire(import.meta.url)
const Database = require('better-sqlite3')
const db = new Database('/data/marketing.db')
const id = 'mleverage-admin:55f9a8bb-73f9-4316-bcd7-7dcdce0bdcc3:5c7a6115-a0a9-4e8d-bf65-efce52195fa4'
const owner = process.env.MARKETING_WORKER_OWNER
const at = () => new Date().toISOString()
db.prepare('INSERT OR IGNORE INTO InquirySyncState(id,source,companyScopeId,homepageScopeId,updatedAt) VALUES(?,?,?,?,?)')
  .run(id,'mleverage-admin','55f9a8bb-73f9-4316-bcd7-7dcdce0bdcc3','5c7a6115-a0a9-4e8d-bf65-efce52195fa4',at())
const claim = db.prepare('UPDATE InquirySyncState SET workerOwner=?,workerHeartbeatAt=?,workerLeaseExpiresAt=?,status=? WHERE id=? AND (workerOwner IS NULL OR workerLeaseExpiresAt < ?)')
if (claim.run(owner,at(),new Date(Date.now()+180000).toISOString(),'ready',id,at()).changes !== 1) process.exit(1)
const timer = setInterval(() => {
  db.prepare('UPDATE InquirySyncState SET workerHeartbeatAt=?,workerLeaseExpiresAt=? WHERE id=? AND workerOwner=?').run(at(),new Date(Date.now()+180000).toISOString(),id,owner)
  if (existsSync(process.env.MARKETING_WORKER_GATE)) {
    db.prepare('UPDATE Customer SET memo=? WHERE id=?').run('synthetic worker committed after activation','synthetic-parallel')
  }
}, 100)
process.once('SIGTERM', () => {
  clearInterval(timer)
  db.prepare('UPDATE InquirySyncState SET workerOwner=NULL,workerHeartbeatAt=NULL,workerLeaseExpiresAt=NULL WHERE id=? AND workerOwner=?').run(id,owner)
  db.close()
  process.exit(0)
})
