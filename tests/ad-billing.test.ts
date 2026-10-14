import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, rm, link, mkdir, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { spawn } from 'node:child_process'
import { BillingError, billingHeaders, billingAmount, emptyBilling, monthDays, parseBillingRecord, previousBillingMonth, selectBilling } from '@/lib/ad-billing'
import { BILLING_CSV_MAX, parseBillingCsv, readBillingCsvBody, type BillingImportMetadata } from '@/lib/ad-billing-csv'
import { billingRevision, previewBilling, readBilling, replaceBilling, saveBilling } from '@/lib/ad-billing-store'
import { billingWorkbook } from '@/lib/ad-billing-xlsx'
import { uploadResponse } from '@/lib/upload-security'

const require = createRequire(import.meta.url)
const { unzipSync } = createRequire(require.resolve('write-excel-file/node'))('fflate')
const now = new Date('2026-10-14T00:00:00.000Z'), header = billingHeaders.join(',')
const september: BillingImportMetadata = { start: '2026-09-01', end: '2026-09-30', scope: 'both', capturedAt: '2026-10-01T00:00:00.000Z', confirmed: true }
const csv = (...rows: string[]) => Buffer.from('\uFEFF' + [header, ...rows].join('\r\n') + '\r\n')
const charge = '2026.09.03. 12:30:05,유상캐시 충전,합성카드(0000),10000'
const spend = '2026.09.30. 23:59:59,광고캐시 사용,광고 집행,300'
const parse = (bytes: Uint8Array, meta = september) => parseBillingCsv(bytes, meta, now)
const mustReject = (fn: () => unknown) => assert.throws(fn, BillingError)

assert.equal(previousBillingMonth(new Date('2026-12-31T15:00:00Z')), '2026-12')
assert.equal(previousBillingMonth(new Date('2026-12-31T14:59:59Z')), '2026-11')
assert.equal(previousBillingMonth(new Date('2026-01-01T00:00:00Z')), '2025-12')
assert.equal(monthDays('2024-02').length, 29)
assert.equal(monthDays('2025-02').length, 28)
for (const invalid of ['2026-13', '../2026-09', '2026-2']) mustReject(() => monthDays(invalid))
assert.equal(billingAmount(999999999999999), 999999999999999)
for (const invalid of [-1, 0.01, 1e15, Number.MAX_SAFE_INTEGER + 1, NaN]) mustReject(() => billingAmount(invalid))
const parsed = parse(csv(charge, charge, spend))
assert.equal(parsed.rows.length, 3, 'identical legitimate top-ups survive')
assert.equal(parsed.rows[0].at, '2026-09-30T23:59:59')
assert.equal(parsed.rows[1].description, '합성카드(0000)')
for (const count of [0, 1, 2, 3]) {
  const officialHeader = billingHeaders.map(value => `"${value}"`).join(',')
  assert.deepEqual(parse(Buffer.from('\uFEFF'.repeat(count) + officialHeader + '\r\n' + charge + '\r\n')).rows, parse(csv(charge)).rows, 'consecutive leading BOMs and quoted official headers are accepted')
}
mustReject(() => parse(csv(',,,')))
const quoted = parse(csv('2026.09.03. 12:30:05,유상캐시 충전," 합성,""카드""\r\n(0000) ","10,000"'))
assert.equal(quoted.rows[0].description, ' 합성,"카드"\r\n(0000) ', 'preserve original text including whitespace and RFC4180 quoting')
assert.equal(quoted.rows[0].amount, 10000)
for (const value of ['=HYPERLINK("https://example.invalid")', '+1+1', '-1+1', '@SUM(1)']) {
  const encoded = value.replaceAll('"', '""')
  assert.equal(parse(csv(`2026.09.03. 12:30:05,유상캐시 충전,"${encoded}",1`)).rows[0].description, value)
}
for (const bytes of [Buffer.from('garbage'), Buffer.from([0xff]), Buffer.alloc(BILLING_CSV_MAX + 1), csv(charge.replace('10000', '-100')), csv(charge.replace('10000', '1.5')), csv(charge.replace('10000', '0')), csv(charge.replace('10000', '1e3')), csv(charge.replace('10000', '9007199254740992')), csv(charge.replace('유상캐시 충전', '유상캐시 환불')), csv(charge.replace('2026.09.03.', '2026.08.31.')), csv(charge.replace('2026.09.03.', '2026.09.31.')), csv(charge.replace('2026.09.03.', '2026.09.03')), csv(charge.replace('12:30:05', '24:00:00')), csv(charge + ',extra'), Buffer.from(header + '\n"unclosed'), Buffer.from(header + '\n"abc"x'), Buffer.from(header.replace('거래 내용,금액', '금액,거래 내용') + '\n' + charge)]) mustReject(() => parse(bytes))
for (const meta of [{ ...september, confirmed: false }, { ...september, scope: 'spend' as const }, { ...september, start: '2026-08-31' }, { ...september, capturedAt: '2026-09-10T00:00:00.000Z' }, { ...september, capturedAt: '2026-10-15T00:00:00.000Z' }]) mustReject(() => parse(csv(charge), meta))
assert.equal(parse(csv()).rows.length, 0, 'confirmed header-only export is a valid zero for this explicit scope')
const input = parse(csv(...Array.from({ length: 27 }, (_, i) => `2026.09.${String(i + 1).padStart(2, '0')}. 23:59:59,광고캐시 사용,광고 집행,100`), ...Array(5).fill(charge)))
const full = replaceBilling(emptyBilling('2026-09'), input, now).record
assert.equal(selectBilling(full, now).ready, true, '27 spend and 5 top-ups can cover the whole month without daily transactions')
assert.deepEqual(selectBilling(full, now).summaries.map(v => [v.count, v.total, v.completeDays]), [[5, 50000, 30], [27, 2700, 30]])
assert.equal(selectBilling(emptyBilling('2026-09'), now).summaries[0].total, null)
const zero = replaceBilling(emptyBilling('2026-09'), parse(csv()), now).record
assert.equal(selectBilling(zero, now).ready, true)
assert.equal(selectBilling(zero, now).summaries[0].total, 0)
const onlyCharges = replaceBilling(emptyBilling('2026-09'), parse(csv(charge), { ...september, scope: 'topup' }), now).record
assert.equal(selectBilling(onlyCharges, now).ready, false, 'both types required')
const oct: BillingImportMetadata = { start: '2026-10-01', end: '2026-10-07', scope: 'spend', capturedAt: '2026-10-07T08:43:52.000Z', confirmed: true }
const octoberRow = '2026.10.07. 23:59:59,광고캐시 사용,광고 집행,500'
const partial = replaceBilling(emptyBilling('2026-10'), parse(csv(octoberRow), oct), now).record
assert.equal(selectBilling(partial, now).ready, false)
assert.deepEqual(selectBilling(partial, now).summaries[1].partialDays, ['2026-10-07'])
assert.equal(selectBilling(partial, now).summaries[1].completeDays, 6)
const later = parse(csv(octoberRow.replace('500', '750')), { ...oct, capturedAt: '2026-10-08T00:00:00.000Z' })
const replaced = replaceBilling(partial, later, now).record
assert.equal(selectBilling(replaced, now).summaries[1].total, 750, 'partial day replacement, never addition')
assert.equal(selectBilling(replaced, now).summaries[1].completeDays, 7)
assert.equal(selectBilling(replaced, new Date('2026-11-01T00:00:00Z')).ready, false, 'time passing cannot fill missing days')
const narrow = parse(csv('2026.09.01. 23:59:59,광고캐시 사용,광고 집행,888'), { ...september, start: '2026-09-01', end: '2026-09-01', scope: 'spend', capturedAt: '2026-10-02T00:00:00.000Z' })
const adjusted = replaceBilling(full, narrow, now).record
assert.equal(selectBilling(adjusted, now).summaries[1].total, 3488)
assert.deepEqual(adjusted.days.filter(day => day.kind === 'topup'), full.days.filter(day => day.kind === 'topup'))
assert.deepEqual(adjusted.days.filter(day => day.date !== '2026-09-01'), full.days.filter(day => day.date !== '2026-09-01'))
mustReject(() => replaceBilling(adjusted, input, now))
mustReject(() => replaceBilling(full, parse(csv(spend.replace('300', '900')), september), now))
const unsafeTotal = parse(csv(charge.replace('10000', '999999999999999'), charge))
mustReject(() => replaceBilling(emptyBilling('2026-09'), unsafeTotal, now))
mustReject(() => parseBillingRecord({ ...full, days: [...full.days, full.days[0]] }, '2026-09'))

function child(root: string, amount: string) {
  return new Promise<string>((resolve, reject) => {
    const p = spawn(process.execPath, ['--import', 'tsx', 'tests/ad-billing-writer-child.ts', root, amount], { cwd: process.cwd(), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = '', errors = ''; p.stdout.on('data', data => { output += data }); p.stderr.on('data', data => { errors += data })
    p.on('error', reject); p.on('close', code => code === 0 ? resolve(output.trim()) : reject(new Error(errors)))
  })
}
async function main() {
  const root = await mkdtemp(path.join(tmpdir(), 'synthetic-billing-')), env = { UPLOADS_DIR: root }, file = path.join(root, '_reports/ad-billing/2026-09.json')
  try {
    assert.deepEqual(await readBilling('2026-09', env), emptyBilling('2026-09'))
    const preview = previewBilling(await readBilling('2026-09', env), input, now)
    assert.equal(await readFile(file).catch(() => null), null, 'preview writes nothing')
    await saveBilling(input, preview.revision, env, now)
    const first = await readFile(file)
    assert.equal((await saveBilling(input, preview.revision, env, now)).unchanged, true)
    assert.deepEqual(await readFile(file), first, 'identical retry does not change bytes or stored time')
    await assert.rejects(saveBilling(narrow, '0'.repeat(64), env, now), /미리보기 이후/)
    assert.deepEqual(await readFile(file), first)
    await saveBilling(narrow, billingRevision(full), env, now)
    assert.equal(selectBilling(await readBilling('2026-09', env), now).summaries[1].total, 3488)
    await writeFile(path.join(root, '_reports/ad-billing/writer.lock'), 'synthetic lock')
    await assert.rejects(saveBilling(input, preview.revision, env, now), /저장 중/)
    await rm(path.join(root, '_reports/ad-billing/writer.lock'))
    const denied = await uploadResponse(root, ['_reports', 'ad-billing', '2026-09.json'], true)
    assert.equal(denied.status, 404)
    await writeFile(file, '{broken')
    await assert.rejects(readBilling('2026-09', env), /저장된 정산/)
    await assert.rejects(saveBilling(input, preview.revision, env, now), /저장된 정산/)
    assert.equal(await readFile(file, 'utf8'), '{broken')
    await writeFile(file, first)
    const hardlink = path.join(root, 'linked.json'); await link(file, hardlink)
    await assert.rejects(readBilling('2026-09', env), /저장된 정산/)
    await rm(hardlink)
    const race = path.join(root, 'race'); await mkdir(path.join(race, '_reports/ad-billing'), { recursive: true })
    const outcomes = await Promise.all([child(race, '100'), child(race, '200')])
    assert.equal(outcomes.filter(result => result === 'saved').length, 1)
    assert.equal(outcomes.filter(result => result === 'conflict').length, 1)
    assert.ok([100, 200].includes(selectBilling(await readBilling('2026-09', { UPLOADS_DIR: race }), now).summaries[1].total!))
    assert.deepEqual((await readdir(path.join(race, '_reports/ad-billing'))).sort(), ['2026-09.json'])
    await assert.rejects(readBillingCsvBody(new Request('https://example.invalid', { method: 'POST', headers: { 'Content-Type': 'text/csv' }, body: Buffer.alloc(BILLING_CSV_MAX + 1) })), BillingError)
    assert.deepEqual(await readBillingCsvBody(new Request('https://example.invalid', { method: 'POST', headers: { 'Content-Type': 'text/csv' }, body: csv(spend) })), csv(spend))
    await assert.rejects(billingWorkbook(emptyBilling('2026-09'), 'spend', now), /미수집/)
    const formulaInput = parse(csv(charge, charge, spend, '2026.09.04. 13:10:00,유상캐시 충전,"=SUM(1,2)",999999999979999'))
    const formulaRecord = replaceBilling(emptyBilling('2026-09'), formulaInput, now).record
    const workbook = await billingWorkbook(formulaRecord, 'topup', now)
    assert.equal(workbook.buffer.subarray(0, 2).toString(), 'PK')
    assert.equal(workbook.filename, '당근_2026-09_충전내역.xlsx')
    const unzip: Record<string, Uint8Array> = unzipSync(workbook.buffer), xml = (name: string) => Buffer.from(unzip[name]).toString()
    const sheet = xml('xl/worksheets/sheet1.xml'), shared = xml('xl/sharedStrings.xml'), styles = xml('xl/styles.xml')
    assert.match(sheet, /<autoFilter ref="A1:D4"\/>/)
    assert.match(sheet, /state="frozen"/); assert.match(sheet, /ySplit="1"/)
    assert.match(sheet, /<cols>/); assert.match(sheet, /width="48"/)
    assert.doesNotMatch(sheet, /<f[ >]/); assert.doesNotMatch(xml('xl/worksheets/sheet2.xml'), /<f[ >]/)
    assert.match(shared, /=SUM\(1,2\)/); assert.match(shared, /합성카드\(0000\)/)
    assert.match(sheet, /<c\b[^>]*r="C2"[^>]*t="s"/)
    const d2 = sheet.match(/<c\b[^>]*r="D2"[^>]*>(.*?)<\/c>/)?.[0] ?? ''
    assert.doesNotMatch(d2, /t="s"/); assert.match(d2, /<v>999999999979999<\/v>/)
    const dateSerial = Number(sheet.match(/<c\b[^>]*r="A2"[^>]*><v>([^<]+)/)?.[1])
    assert.ok(Math.abs(dateSerial - (Date.UTC(2026, 8, 4, 13, 10) - Date.UTC(1899, 11, 30)) / 86400000) < 1e-8, 'real numeric Excel date preserves Korea wall time')
    assert.match(styles, /yyyy.mm.dd. hh:mm:ss/); assert.match(styles, /#,##0/)
    const partialWorkbook = await billingWorkbook(partial, 'spend', now)
    assert.match(partialWorkbook.filename, /중간집계\.xlsx$/)
    const zeroWorkbook = await billingWorkbook(zero, 'spend', now)
    assert.match(Buffer.from(unzipSync(zeroWorkbook.buffer)['xl/worksheets/sheet1.xml']).toString(), /autoFilter ref="A1:D1"/)
    console.log('Ad billing passed: KST months/leap, strict RFC4180 and money, partial-day coverage, duplicate rows, replacement/idempotency/fences, cross-process writer lock, private/corrupt storage, real typed XLSX and formula safety')
  } finally { await rm(root, { recursive: true, force: true }) }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
