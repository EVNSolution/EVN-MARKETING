import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { DAANGN_CSV_MAX, importDaangnCsv, previewDaangnCsv, readDaangnCsvBody } from '@/lib/daangn-ad-spend'
import { readAdSpend, saveAdSpendActions } from '@/lib/ad-spend-store'
import { selectAdSpend } from '@/lib/ad-spend'
const header = '기간,캠페인 이름,캠페인 ID,비용 (VAT 포함),노출 수,도달 수,클릭 수,클릭률,클릭당 비용(CPC),노출당 비용(CPM)'
const row = '2026.09.11.,evn 솔루션,1786077964797444000,"1,234.10",10,9,2,20%,617.05,123410'
const text = '\uFEFF' + header + '\r\n' + row + '\r\n'
const now = new Date('2026-09-13T00:00:00.000Z')
const parse = (value: string) => previewDaangnCsv(Buffer.from(value), '2026-09-11', '2026-09-12', now)
assert.equal(parse(text).amount, '1234.10')
assert.deepEqual(parse(text).missingDays, ['2026-09-12'])
assert.equal(parse(text).campaignId, '1786077964797444000')
assert.equal(parse(text.replace('evn 솔루션', '이름 변경 EVN')).rowCount, 1, 'immutable campaign ID controls scope, not mutable name')
assert.equal(parse(text.replace('"1,234.10"', '0')).amount, '0', 'explicit provider zero is retained')
for (const value of [header, text + row, text.replace('1786077964797444000', '1786077964797444001'), text.replace('2026.09.11.', '2026.09.13.'),
  text.replace('"1,234.10"', '=1+1'), text.replace('"1,234.10"', '-1'), text.replace('"1,234.10"', '1e3'), text.replace('기간,', '기간,광고그룹,'),
  text.replace('비용 (VAT 포함)', '비용 (VAT 제외)'), text.replace('2026.09.11.', '합계'), text.replace('2026.09.11.', '2026.09.11.~2026.09.12.'),
  text.replace('1786077964797444000', '="1786077964797444000"'), text.replace('10,9,2', '@SUM(1),9,2'),
]) assert.throws(() => parse(value))
assert.throws(() => previewDaangnCsv(new Uint8Array([0xff]), '2026-09-11', '2026-09-12', now))
assert.throws(() => previewDaangnCsv(new Uint8Array(DAANGN_CSV_MAX + 1), '2026-09-11', '2026-09-12', now))
assert.notEqual(parse(text).hash, parse(text.replace('1,234.10', '1,234.20')).hash)
async function main() {
  const root = await mkdtemp(path.join(tmpdir(), 'daangn-synthetic-')), env = { UPLOADS_DIR: root }
  try {
    const preview = parse(text)
    await importDaangnCsv(preview, env, now)
    const original = await readAdSpend(env), selected = selectAdSpend(original, preview.start, preview.end)
    assert.equal(selected.providers.daangn.status, 'partial')
    assert.equal(selected.providers.daangn.total, null)
    assert.equal(selected.providers.daangn.groups[0].amount, '1234.10')
    assert.equal(original.lastDaangnImport?.rows, 1)
    await importDaangnCsv(preview, env, new Date('2026-09-13T01:00:00.000Z'))
    assert.equal((await readAdSpend(env)).rows.length, 2, 'repeat replaces and retains the missing-day placeholder')
    const before = await readFile(path.join(root, '_reports/ad-spend/current.json'), 'utf8')
    await assert.rejects(saveAdSpendActions([], env, now, async () => { throw new Error('fenced') }), /fenced/)
    assert.equal(await readFile(path.join(root, '_reports/ad-spend/current.json'), 'utf8'), before)
    const bytes = await readDaangnCsvBody(new Request('http://localhost/import', { method: 'POST', headers: { 'Content-Type': 'text/csv' }, body: text }))
    assert.equal(parse(bytes.toString()).amount, '1234.10')
    await assert.rejects(readDaangnCsvBody(new Request('http://localhost/import', { method: 'POST', headers: { 'Content-Type': 'text/csv' }, body: 'x'.repeat(DAANGN_CSV_MAX + 1) })))
    await assert.rejects(readDaangnCsvBody(new Request('http://localhost/import', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: text })))
  } finally { await rm(root, { recursive: true, force: true }) }
  console.log('Daangn CSV passed: BOM/quoted values, exact ID and money, strict headers/date/scope/duplicates/formula bounds, preview, missing dates, atomic replace and import receipt')
}
void main()
