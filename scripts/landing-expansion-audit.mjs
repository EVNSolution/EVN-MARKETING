// Read-only preservation evidence for the one pinned landing schema expansion.
// The host coordinator must hold the release lock and stop all volume writers.
import { createHash } from 'node:crypto'
import { createReadStream, lstatSync, realpathSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkSchema } from './schema-check.mjs'
import { annotateCompatibility, landingSchemaPolicy as policy } from './schema-compatibility.mjs'

const Database = createRequire(import.meta.url)('better-sqlite3')
const json = value => JSON.stringify(value, (_, item) => typeof item === 'bigint' ? { integer:String(item) } : item)
const hash = value => createHash('sha256').update(value).digest('hex')
const fail = () => { throw new Error('landing_expansion_audit') }
const quote = name => '"'+name.replaceAll('"','""')+'"'
function safe(file, directory=false) {
  if (!path.isAbsolute(file) || path.normalize(file)!==file || realpathSync(file)!==file) fail()
  const info=lstatSync(file)
  if (info.isSymbolicLink() || (directory ? !info.isDirectory() : !info.isFile() || info.nlink!==1)) fail()
  return info
}
async function files(root, relative='') {
  safe(root,true)
  const entries=[]
  for (const name of (await readdir(root)).sort()) {
    if (name.includes('\\')) fail()
    const file=path.join(root,name), item=relative ? relative+'/'+name : name
    if (lstatSync(file).isDirectory()) entries.push(...await files(file,item))
    else {
      const info=safe(file), digest=createHash('sha256')
      for await (const chunk of createReadStream(file)) digest.update(chunk)
      entries.push({path:item,bytes:info.size,sha256:digest.digest('hex')})
    }
  }
  return entries
}
export async function expansionAudit(directory, expected) {
  if (!['baseline','expanded'].includes(expected)) fail()
  safe(directory,true)
  const file=path.join(directory,'marketing.db')
  safe(file)
  const bridge=annotateCompatibility(policy.baseline)
  const checked=checkSchema(file,bridge,bridge)
  if (checked.storageContractSha256!==policy[expected+'ContractSha256']) fail()
  const db=new Database(file,{readonly:true,fileMustExist:true,timeout:1000})
  db.defaultSafeIntegers()
  const rows={}, hashes={}
  let addedRows
  try {
    db.exec('BEGIN')
    if (db.prepare('SELECT workerOwner,lockOwner FROM InquirySyncState').all().some(r=>r.workerOwner||r.lockOwner)) fail()
    const names=[...policy.baseline.schema.filter(s=>s.type==='table').map(s=>s.name),'_prisma_migrations'].sort()
    for (const name of names) {
      const columns=db.prepare(`PRAGMA table_info(${quote(name)})`).all().map(c=>quote(c.name))
      const digest=createHash('sha256')
      let count=0
      const filter=name==='_prisma_migrations' ? ' WHERE migration_name != ?' : ''
      const statement=db.prepare(`SELECT * FROM ${quote(name)}${filter} ORDER BY ${columns.join(',')}`)
      for (const row of statement.iterate(...(filter ? [policy.id] : []))) {digest.update(json(row)+'\n');count++}
      rows[name]=count;hashes[name]=digest.digest('hex')
    }
    addedRows=expected==='expanded'
      ? ['LandingReceipt','LandingThrottle'].map(name=>Number(db.prepare(`SELECT count(*) count FROM ${quote(name)}`).get().count)) : [0,0]
  } finally {db.close()}
  const uploads=await files(path.join(directory,'uploads'))
  return {format:1,ok:true,contractSha256:checked.storageContractSha256,rows,hashes,addedRows,
    files:uploads.length,uploadBytes:uploads.reduce((sum,f)=>sum+f.bytes,0),filesSha256:hash(json(uploads))}
}
export function assertExpansionPreserved(before,after) {
  if (before?.format!==1 || after?.format!==1 || before.ok!==true || after.ok!==true
    || before.contractSha256!==policy.baselineContractSha256 || after.contractSha256!==policy.expandedContractSha256
    || json(after.addedRows)!=='[0,0]') fail()
  for (const key of ['rows','hashes','files','uploadBytes','filesSha256']) if (json(before[key])!==json(after[key])) fail()
  return {ok:true,existingDataPreserved:true}
}
if (process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  try {
    const [expected,directory]=process.argv.slice(2)
    if (process.argv.length!==4) fail()
    console.log(json(await expansionAudit(directory,expected)))
  } catch {console.log(json({ok:false,reason:'landing_expansion_audit'}));process.exitCode=1}
}
