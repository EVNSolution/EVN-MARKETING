import writeExcelFile, { type SheetData } from 'write-excel-file/node'
import { BillingError, billingHeaders, billingLabels, billingTypes, orderedRows, selectBilling, type BillingKind, type BillingRecord } from './ad-billing'

export async function billingWorkbook(record: BillingRecord, kind: BillingKind, now = new Date()) {
  const view = selectBilling(record, now), summary = view.summaries.find(item => item.kind === kind)!
  if (!summary || summary.total === null) throw new BillingError('missing', '이 유형은 아직 원본 자료를 가져오지 않았습니다. 미수집은 0원이 아닙니다.', 409)
  const rows = orderedRows(record.days.filter(day => day.kind === kind).flatMap(day => day.rows))
  const data: SheetData = [billingHeaders.map(value => ({ value, type: String, fontWeight: 'bold', backgroundColor: '#111111', textColor: '#FFFFFF', height: 28 })),
    ...rows.map((row): SheetData[number] => [
      // The numeric Excel date encodes Korea wall time; never apply the server's local timezone.
      { value: new Date(`${row.at}.000Z`), type: Date, format: 'yyyy.mm.dd. hh:mm:ss' },
      { value: row.type, type: String },
      // Explicit String cells preserve original text, including =,+,-,@, without formula execution.
      { value: row.description, type: String, format: '@', wrap: true },
      { value: row.amount, type: Number, format: '#,##0', align: 'right' },
    ])]
  const metadata: SheetData = [
    ['항목', '내용'].map(value => ({ value, type: String, fontWeight: 'bold', backgroundColor: '#E9EFBA' })),
    ['정산 월', record.month], ['거래 유형', billingTypes[kind]], ['상태', view.ready ? '준비 완료' : '중간집계'],
    ['조회 범위', summary.ranges.map(range => `${range.start} ~ ${range.end}`).join(', ')],
    ['하루 전체 자료 확인', `${summary.completeDays} / ${view.dayCount}일`],
    ['부분일', summary.partialDays.join(', ') || '없음'], ['미수집 날짜', summary.missingDays.join(', ') || '없음'],
    ['거래 건수', { value: summary.count!, type: Number, format: '#,##0' }],
    ['합계 (원)', { value: summary.total, type: Number, format: '#,##0' }],
    ['최신 수집 기준시각 (한국시간)', new Date(new Date(summary.capturedAt!).getTime() + 9 * 3600000).toISOString().replace('T', ' ').slice(0, 19)],
    ['마지막 저장시각 (한국시간)', new Date(new Date(summary.importedAt!).getTime() + 9 * 3600000).toISOString().replace('T', ' ').slice(0, 19)],
    ['집계 안내', '충전과 집행은 별도 거래입니다. 두 금액을 합쳐 광고비로 계산하지 않습니다.'],
    ['범위 안내', '건수가 아니라 사용자가 확인한 원본 조회 기간·유형·수집 기준시각으로 자료 범위를 판정합니다.'],
    ['중간집계 안내', '양쪽 유형의 월 전체 자료가 확인된 지난달까지 준비 완료로 표시합니다. 수집 당일은 부분일입니다.'],
  ]
  for (const row of metadata.slice(1)) {
    if (typeof row[1] === 'string') {
      const value = row[1], displayWidth = [...value].reduce((width, c) => width + (c.charCodeAt(0) > 127 ? 2 : 1), 0)
      row[1] = { value, type: String, wrap: true, alignVertical: 'top', height: Math.max(22, Math.ceil(displayWidth / 100) * 20) }
    }
  }
  // Supported library extension: add the worksheet auto-filter immediately after sheetData.
  const filter = { files: { transform: { 'xl/worksheets/sheet{id}.xml': {
    transform: (xml: string, _options: unknown, properties: { sheetIndex: number }) => properties.sheetIndex === 0
      ? xml.replace('</sheetData>', `</sheetData><autoFilter ref="A1:D${data.length}"/>`) : xml,
  } } } }
  const buffer = await writeExcelFile([
    { sheet: billingLabels[kind], data, columns: [{ width: 25 }, { width: 20 }, { width: 48 }, { width: 23 }], stickyRowsCount: 1 },
    { sheet: '자료정보', data: metadata, columns: [{ width: 33 }, { width: 110 }], stickyRowsCount: 1 },
  ], { fontFamily: 'Malgun Gothic', fontSize: 11, features: [filter] }).toBuffer()
  return { buffer, filename: `당근_${record.month}_${billingLabels[kind]}${view.ready ? '' : '_중간집계'}.xlsx` }
}
