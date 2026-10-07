// A single reviewed expansion; this is not a general additive-migration policy.
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

export const landingSchemaPolicy = JSON.parse(readFileSync(new URL('./landing-schema-policy.json', import.meta.url), 'utf8'))
export const schemaContract = manifest => createHash('sha256').update(JSON.stringify({
  prismaSchemaSha256: manifest.prismaSchemaSha256,
  migrations: manifest.migrations,
  schema: manifest.schema,
})).digest('hex')

const baseline = 'be0bbaab3f91511d72fca7dd533179bbf9e54d25bd9ce8c215ce128db9e23ae6'
const expanded = 'ce708b8e46cf000c4058ca7163ab54a2bde00b3fa675d950961463ee514bca26'
if (landingSchemaPolicy.format !== 1 || landingSchemaPolicy.id !== '20261007000100_landing_inquiries'
  || landingSchemaPolicy.baselineContractSha256 !== baseline
  || landingSchemaPolicy.expandedContractSha256 !== expanded
  || schemaContract(landingSchemaPolicy.baseline) !== baseline
  || schemaContract(landingSchemaPolicy.expanded) !== expanded) throw new Error('schema_policy')

const capable = manifest => manifest.schemaCompatibility?.landingExpansion === expanded

export function annotateCompatibility(manifest) {
  if (![baseline, expanded].includes(schemaContract(manifest))) return manifest
  return { ...manifest, schemaCompatibility: { landingExpansion: expanded } }
}

export function compatibleSchemas(current, previous) {
  const a = schemaContract(current), b = schemaContract(previous)
  if (a === b) {
    // Bridge recovery must support the database both before and after expansion.
    // An original release without this capability may NOT be the rollback target.
    return a === baseline && capable(current) && capable(previous)
      ? [current, landingSchemaPolicy.expanded] : [current]
  }
  if (new Set([a, b]).size === 2 && [a, b].every(v => [baseline, expanded].includes(v))
    && capable(current) && capable(previous)) return [landingSchemaPolicy.expanded]
  throw new Error('schema_change_requires_review')
}
