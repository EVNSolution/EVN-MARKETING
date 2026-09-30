// CI only: the expanded synthetic DB can exercise old/new web code, while the
// production release gate MUST still reject this unreviewed schema transition.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { checkSchema } from '/app/schema-check.mjs'

const current = JSON.parse(readFileSync('/app/schema-manifest.json', 'utf8'))
const previous = JSON.parse(readFileSync('/previous.json', 'utf8'))
const database = '/data/marketing.db'
assert.equal(current.migrations.at(-1).name, '20260930000100_warp_phone_check')
assert.deepEqual(current.migrations.slice(0, -1), previous.migrations)
assert.throws(() => checkSchema(database, current, previous), /schema_change_requires_review/)
assert.equal(checkSchema(database, current, current).ok, true)
console.log(JSON.stringify({ ok: true, synthetic: true, migrationUnchanged: false, productionTransition: 'review-required' }))
