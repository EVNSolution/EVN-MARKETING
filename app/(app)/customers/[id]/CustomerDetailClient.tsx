'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import AssigneePicker from '@/components/AssigneePicker'
import { useRouter } from 'next/navigation'
import { formatPhone, hasPlateSpacing, unknownCustomerName } from '@/lib/format'
import { FIELD_CLS } from '@/lib/ui'
import { SectionHeader } from '@/components/SectionCard'

const SOURCES  = ['소개', '온라인', '전시장/이벤트', '직접방문', '전단지/명함', '기타']
const CONTACT_TITLES = ['대표이사', '사장', '부사장', '전무이사', '상무이사', '이사', '본부장', '실장', '부장', '차장', '과장', '팀장', '파트장', '대리', '책임', '주임', '사원']
const SHIPPER_PRESETS = ['컬리', '쿠팡', 'CJ대한통운']
const INDUSTRY_CHIPS = ['화주', '운송사', '기타']
const REGIONS: Record<string, string[]> = {
  '서울특별시':    ['강남구','강동구','강북구','강서구','관악구','광진구','구로구','금천구','노원구','도봉구','동대문구','동작구','마포구','서대문구','서초구','성동구','성북구','송파구','양천구','영등포구','용산구','은평구','종로구','중구','중랑구'],
  '부산광역시':    ['강서구','금정구','기장군','남구','동구','동래구','부산진구','북구','사상구','사하구','서구','수영구','연제구','영도구','중구','해운대구'],
  '대구광역시':    ['군위군','남구','달서구','달성군','동구','북구','서구','수성구','중구'],
  '인천광역시':    ['강화군','계양구','남동구','동구','미추홀구','부평구','서구','연수구','옹진군','중구'],
  '광주광역시':    ['광산구','남구','동구','북구','서구'],
  '대전광역시':    ['대덕구','동구','서구','유성구','중구'],
  '울산광역시':    ['남구','동구','북구','울주군','중구'],
  '세종특별자치시': ['세종시'],
  '경기도':       ['가평군','고양시','과천시','광명시','광주시','구리시','군포시','김포시','남양주시','동두천시','부천시','성남시','수원시','시흥시','안산시','안성시','안양시','양주시','양평군','여주시','연천군','오산시','용인시','의왕시','의정부시','이천시','파주시','평택시','포천시','하남시','화성시'],
  '강원특별자치도': ['강릉시','고성군','동해시','삼척시','속초시','양구군','양양군','영월군','원주시','인제군','정선군','철원군','춘천시','태백시','평창군','홍천군','화천군','횡성군'],
  '충청북도':     ['괴산군','단양군','보은군','영동군','옥천군','음성군','제천시','증평군','진천군','청주시','충주시'],
  '충청남도':     ['계룡시','공주시','금산군','논산시','당진시','보령시','부여군','서산시','서천군','아산시','예산군','천안시','청양군','태안군','홍성군'],
  '전북특별자치도': ['고창군','군산시','김제시','남원시','무주군','부안군','순창군','완주군','익산시','임실군','장수군','전주시','정읍시','진안군'],
  '전라남도':     ['강진군','고흥군','곡성군','광양시','구례군','나주시','담양군','목포시','무안군','보성군','순천시','신안군','여수시','영광군','영암군','완도군','장성군','장흥군','진도군','함평군','해남군','화순군'],
  '경상북도':     ['경산시','경주시','고령군','구미시','김천시','문경시','봉화군','상주시','성주군','안동시','영덕군','영양군','영주시','영천시','예천군','울릉군','울진군','의성군','청도군','청송군','칠곡군','포항시'],
  '경상남도':     ['거제시','거창군','고성군','김해시','남해군','밀양시','사천시','산청군','양산시','의령군','진주시','창녕군','창원시','통영시','하동군','함안군','함양군','합천군'],
  '제주특별자치도': ['서귀포시','제주시'],
}
const CITIES = Object.keys(REGIONS)


const ACT_COLOR: Record<string, string> = {
  '통화': 'bg-blue-100 text-blue-700',
  '방문': 'bg-green-100 text-green-700',
  '이메일': 'bg-violet-100 text-violet-700',
  '문자': 'bg-amber-100 text-amber-700',
  '기타': 'bg-slate-100 text-slate-500',
}

type Activity = {
  id: string; type: string; date: string
  content: string | null; result: string | null; nextAction: string | null; assignee: string | null
}
type Customer = {
  id: string; name: string; phone: string | null; email: string | null
  customerSegment: string | null; customerCategory: string | null; status: string; grade: string | null
  source: string | null; assignee: string | null; isAgent: boolean; memo: string | null
  regionCity: string | null; regionDist: string | null
  /* B2C */
  gender: string | null; birthInfo: string | null; maritalStatus: string | null
  childrenCount: number | null; addressDetail: string | null; isSoleProprietor: boolean | null
  soleBusinessName: string | null; soleBusinessNo: string | null; soleBusinessType: string | null
  /* B2B */
  b2bCategory: string | null; companyName: string | null; businessRegNo: string | null
  contactTitle: string | null; industry: string | null
  companyAddress: string | null; companyPhone: string | null; employeeCount: number | null
  mainContactCardUrl: string | null; contactsJson: string | null
  /* 차량 */
  hasVehicle: boolean | null; vehicleMaker: string | null; vehicleName: string | null
  vehiclePlateNo: string | null
  vehicleYear: string | null; totalMileage: number | null; vehicleCount: number | null
  vehicleListJson: string | null
  documentsJson: string | null
  b2bRevenue1: string | null; b2bRevenue2: string | null; b2bRevenue3: string | null
  truckType1: string | null; truckType2: string | null; truckType3: string | null; truckType4: string | null
  /* 화주 */
  shipperName: string | null; cargoType: string | null
  deliveryCity: string | null; deliveryDist: string | null; deliveryFreq: string | null
  workShift: string | null; monthlyIncome: string | null; cargoNote: string | null
  collectedAt: string | null; createdAt: string
  activities: Activity[]
}

export default function CustomerDetailClient({ customer, returnTo }: { customer: Customer; returnTo?: string }) {
  const router = useRouter()

  const [f, setF] = useState({
    /* 기본 */
    name:             customer.name,
    phone:            customer.phone            ?? '',
    email:            customer.email            ?? '',
    customerSegment:  customer.customerSegment  ?? 'B2C',
    customerCategory: customer.customerCategory ?? '',
    status:           customer.status,
    grade:            customer.grade            ?? '',
    source:           customer.source           ?? '',
    collectedAt:      customer.collectedAt      ? customer.collectedAt.slice(0, 10) : '',
    assignee:         customer.assignee         ?? '',
    isAgent:          customer.isAgent          ?? false,
    memo:             customer.memo             ?? '',
    regionCity:       customer.regionCity       ?? '',
    regionDist:       customer.regionDist       ?? '',
    /* B2C 개인정보 */
    gender:           customer.gender           ?? '',
    birthInfo:        customer.birthInfo         ?? '',
    maritalStatus:    customer.maritalStatus    ?? '',
    childrenCount:    customer.childrenCount != null ? String(customer.childrenCount) : '',
    addressDetail:    customer.addressDetail    ?? '',
    /* B2C 개인사업자 */
    isSoleProprietor: customer.isSoleProprietor ?? null as boolean | null,
    soleBusinessName: customer.soleBusinessName ?? '',
    soleBusinessNo:   customer.soleBusinessNo   ?? '',
    soleBusinessType: customer.soleBusinessType ?? '',
    /* B2B */
    b2bCategory:      customer.b2bCategory      ?? '',
    companyName:      customer.companyName      ?? '',
    businessRegNo:    customer.businessRegNo    ?? '',
    contactTitle:     customer.contactTitle     ?? '',
    industry:         customer.industry         ?? '',
    companyAddress:   customer.companyAddress   ?? '',
    companyPhone:     customer.companyPhone     ?? '',
    employeeCount:    customer.employeeCount != null ? String(customer.employeeCount) : '',
    b2bRevenue1:      customer.b2bRevenue1      ?? '',
    b2bRevenue2:      customer.b2bRevenue2      ?? '',
    b2bRevenue3:      customer.b2bRevenue3      ?? '',
    /* 차량 */
    vehicleMaker:     customer.vehicleMaker     ?? '',
    vehicleName:      customer.vehicleName      ?? '',
    vehiclePlateNo:   customer.vehiclePlateNo   ?? '',
    vehicleYear:      customer.vehicleYear      ?? '',
    totalMileage:     customer.totalMileage != null ? customer.totalMileage.toLocaleString() : '',
    vehicleCount:     customer.vehicleCount != null ? String(customer.vehicleCount) : '',
    truckType1:       customer.truckType1       ?? '',
    truckType2:       customer.truckType2       ?? '',
    truckType3:       customer.truckType3       ?? '',
    truckType4:       customer.truckType4       ?? '',
    /* 화주 */
    shipperName:      customer.shipperName      ?? '',
    cargoType:        customer.cargoType        ?? '',
    deliveryCity:     customer.deliveryCity     ?? '',
    deliveryDist:     customer.deliveryDist     ?? '',
    deliveryFreq:     customer.deliveryFreq     ?? '',
    workShift:        customer.workShift        ?? '',
    monthlyIncome:    customer.monthlyIncome    ?? '',
    cargoNote:        customer.cargoNote        ?? '',
  })
  const [saving,  setSaving]  = useState(false)
  const [saved,   setSaved]   = useState(true)
  const [msg,     setMsg]     = useState('')

  /* 활동 상태 */
  const [activities, setActivities] = useState<Activity[]>(customer.activities)
  const [showActForm, setShowActForm] = useState(false)
  const [act, setAct] = useState({ type: '통화', date: new Date().toISOString().slice(0, 16), content: '', result: '', nextAction: '', assignee: '' })
  const [savingAct, setSavingAct] = useState(false)

  /* B2B 첨부파일 */
  type DocMeta = { type: string; name: string; path: string; size: number; uploadedAt: string }
  const [docs, setDocs] = useState<DocMeta[]>(() => {
    if (!customer.documentsJson) return []
    try { return JSON.parse(customer.documentsJson) } catch { return [] }
  })
  const [uploading, setUploading] = useState<string | null>(null)

  const handleDocUpload = async (docType: string, file: File) => {
    setUploading(docType)
    try {
      const fd = new FormData()
      fd.append('file', file)
      fd.append('type', docType)
      const res = await fetch(`/api/customers/${customer.id}/documents`, { method: 'POST', body: fd })
      const data = await res.json()
      setDocs(prev => [...prev.filter(d => d.type !== docType), data.doc])
    } finally { setUploading(null) }
  }

  const handleDocDelete = async (docType: string) => {
    if (!confirm(`"${docType}" 파일을 삭제할까요?`)) return
    await fetch(`/api/customers/${customer.id}/documents?type=${encodeURIComponent(docType)}`, { method: 'DELETE' })
    setDocs(prev => prev.filter(d => d.type !== docType))
  }

  /* B2B 보유차량 목록 */
  const [vehicleList, setVehicleList] = useState<{ name: string; count: string }[]>(() => {
    if (customer.vehicleListJson) {
      try {
        const parsed = JSON.parse(customer.vehicleListJson)
        if (Array.isArray(parsed) && parsed.length > 0) return parsed
      } catch { /* fall through */ }
    }
    if (customer.vehicleName || customer.vehicleCount != null) {
      return [{ name: customer.vehicleName ?? '', count: customer.vehicleCount != null ? String(customer.vehicleCount) : '' }]
    }
    return [{ name: '', count: '' }]
  })

  /* B2B 대표 담당자 명함 */
  const [mainCardUrl, setMainCardUrl] = useState<string | null>(customer.mainContactCardUrl ?? null)
  const [mainCardUploading, setMainCardUploading] = useState(false)

  const handleMainCardUpload = async (file: File) => {
    setMainCardUploading(true)
    try {
      const fd = new FormData()
      fd.append('file', file)
      const res = await fetch(`/api/customers/${customer.id}/contact-card`, { method: 'POST', body: fd })
      const data = await res.json()
      setMainCardUrl(data.url)
    } finally { setMainCardUploading(false) }
  }
  const handleMainCardDelete = async () => {
    if (!confirm('명함 이미지를 삭제할까요?')) return
    await fetch(`/api/customers/${customer.id}/contact-card`, { method: 'DELETE' })
    setMainCardUrl(null)
  }

  /* B2B 관계자 목록 */
  type Contact = { id: string; name: string; phone: string; title: string; role: string; email: string; note: string; cardUrl: string | null }
  const [contacts, setContacts] = useState<Contact[]>(() => {
    if (!customer.contactsJson) return []
    try {
      const parsed = JSON.parse(customer.contactsJson)
      return Array.isArray(parsed) ? parsed : []
    } catch { return [] }
  })
  const [contactUploading, setContactUploading] = useState<string | null>(null)

  const updateContact = (id: string, patch: Partial<Contact>) => {
    setContacts(prev => prev.map(c => c.id === id ? { ...c, ...patch } : c))
    setSaved(false)
  }
  const addContact = () => {
    setContacts(prev => [...prev, { id: crypto.randomUUID(), name: '', phone: '', title: '', role: '', email: '', note: '', cardUrl: null }])
    setSaved(false)
  }
  const removeContact = async (id: string) => {
    const target = contacts.find(c => c.id === id)
    if (target?.cardUrl) {
      await fetch(`/api/customers/${customer.id}/contact-card?contactId=${encodeURIComponent(id)}`, { method: 'DELETE' }).catch(() => {})
    }
    setContacts(prev => prev.filter(c => c.id !== id))
    setSaved(false)
  }
  const handleContactCardUpload = async (contactId: string, file: File) => {
    setContactUploading(contactId)
    try {
      const fd = new FormData()
      fd.append('file', file)
      fd.append('contactId', contactId)
      const res = await fetch(`/api/customers/${customer.id}/contact-card`, { method: 'POST', body: fd })
      const data = await res.json()
      setContacts(prev => prev.map(c => c.id === contactId ? { ...c, cardUrl: data.url } : c))
    } finally { setContactUploading(null) }
  }
  const handleContactCardDelete = async (contactId: string) => {
    if (!confirm('명함 이미지를 삭제할까요?')) return
    await fetch(`/api/customers/${customer.id}/contact-card?contactId=${encodeURIComponent(contactId)}`, { method: 'DELETE' })
    setContacts(prev => prev.map(c => c.id === contactId ? { ...c, cardUrl: null } : c))
  }

  /* 고객분류 칩 선택 */
  const initIndustry = customer.industry ?? ''
  const initIndustryChip = INDUSTRY_CHIPS.slice(0, 2).includes(initIndustry) ? initIndustry : initIndustry ? '기타' : ''
  const [industryChip,   setIndustryChip]   = useState(initIndustryChip)
  const [industryCustom, setIndustryCustom] = useState(
    INDUSTRY_CHIPS.slice(0, 2).includes(initIndustry) ? '' : initIndustry
  )

  /* 화주명 칩 선택 */
  const initShipperChip = customer.shipperName
    ? SHIPPER_PRESETS.includes(customer.shipperName) ? customer.shipperName : '직접입력'
    : ''
  const [shipperChip,   setShipperChip]   = useState(initShipperChip)
  const [shipperCustom, setShipperCustom] = useState(
    customer.shipperName && !SHIPPER_PRESETS.includes(customer.shipperName) ? customer.shipperName : ''
  )

  /* 제조사 직접입력 */
  const MAKER_PRESETS = ['현대', '기아', 'EVKMC', '이브이앤솔루션']
  const MAKER_CHIP_OPTS = [...MAKER_PRESETS, '미보유']
  const initMakerChip = customer.vehicleMaker
    ? MAKER_CHIP_OPTS.includes(customer.vehicleMaker) ? customer.vehicleMaker : '직접입력'
    : ''
  const [makerChip,   setMakerChip]   = useState(initMakerChip)
  const [makerCustom, setMakerCustom] = useState(
    customer.vehicleMaker && !MAKER_CHIP_OPTS.includes(customer.vehicleMaker) ? customer.vehicleMaker : ''
  )

  /* 근무패턴 직접입력 */
  const SHIFT_PRESETS = ['주간', '야간']
  const initShiftChip = customer.workShift
    ? SHIFT_PRESETS.includes(customer.workShift) ? customer.workShift : '직접입력'
    : ''
  const [shiftChip,   setShiftChip]   = useState(initShiftChip)
  const [shiftCustom, setShiftCustom] = useState(
    customer.workShift && !SHIFT_PRESETS.includes(customer.workShift) ? customer.workShift : ''
  )

  const setFv = (k: string, v: string) => {
    const val = (k === 'phone' || k === 'companyPhone') ? formatPhone(v) : v
    setF(p => ({ ...p, [k]: val }))
    setSaved(false)
  }

  // "신원미상" 모드(이름이 "미상"으로 시작)일 때는 지역/차량번호가 바뀔 때마다 이름을 자동으로 갱신한다.
  // (버튼을 누른 시점의 값으로 한 번만 채워지면, 그 뒤에 차량번호를 입력해도 반영되지 않아 혼란스러움)
  useEffect(() => {
    if (!f.name.startsWith('미상')) return
    const next = unknownCustomerName({
      region:  f.regionDist || f.regionCity,
      plateNo: f.vehiclePlateNo,
      phone:   f.phone,
    })
    if (next !== f.name) setFv('name', next)
  }, [f.vehiclePlateNo, f.regionCity, f.regionDist, f.phone])

  const handleSave = async () => {
    setSaving(true)
    try {
      const res = await fetch(`/api/customers/${customer.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(Object.assign({}, f, {
          phone:            f.phone            || null,
          email:            f.email            || null,
          grade:            f.grade            || null,
          source:           f.source           || null,
          collectedAt:      f.collectedAt ? new Date(f.collectedAt).toISOString() : (customer.collectedAt || new Date().toISOString()),
          isAgent:          f.isAgent,
          regionCity:       f.regionCity       || null,
          regionDist:       f.regionDist       || null,
          // B2C 개인정보
          gender:           f.gender           || null,
          birthInfo:        f.birthInfo        || null,
          maritalStatus:    f.maritalStatus    || null,
          childrenCount:    f.childrenCount    ? parseInt(f.childrenCount) : null,
          addressDetail:    f.addressDetail    || null,
          isSoleProprietor: f.isSoleProprietor ?? null,
          soleBusinessName: f.isSoleProprietor ? f.soleBusinessName || null : null,
          soleBusinessNo:   f.isSoleProprietor ? f.soleBusinessNo   || null : null,
          soleBusinessType: f.isSoleProprietor ? f.soleBusinessType || null : null,
          // B2B
          b2bCategory:      f.b2bCategory      || null,
          companyName:      f.companyName      || null,
          businessRegNo:    f.businessRegNo    || null,
          contactTitle:     f.contactTitle     || null,
          industry:         (industryChip === '기타' ? industryCustom : industryChip) || null,
          companyAddress:   f.companyAddress   || null,
          companyPhone:     f.companyPhone     || null,
          employeeCount:    f.employeeCount ? parseInt(f.employeeCount.replace(/,/g, ''), 10) : null,
          contactsJson:     f.customerSegment === 'B2B' ? JSON.stringify(contacts) : null,
          b2bRevenue1:      f.b2bRevenue1      || null,
          b2bRevenue2:      f.b2bRevenue2      || null,
          b2bRevenue3:      f.b2bRevenue3      || null,
          customerCategory: f.customerCategory || null,
          // 차량
          totalMileage:   f.totalMileage  ? parseInt(f.totalMileage.replace(/,/g, ''), 10) : null,
          vehicleListJson: f.customerSegment === 'B2B'
            ? JSON.stringify(vehicleList.filter(r => r.name || r.count))
            : null,
          vehicleMaker: (makerChip  === '직접입력' ? makerCustom  : makerChip)  || null,
          vehicleName:  f.vehicleName   || null,
          vehiclePlateNo: f.vehiclePlateNo || null,
          vehicleYear:  f.vehicleYear   || null,
          truckType1:   f.truckType1    || null,
          truckType2:   f.truckType2    || null,
          truckType3:   f.truckType3    || null,
          truckType4:   f.truckType4    || null,
          // 화주
          shipperName:  (shipperChip === '직접입력' ? shipperCustom : shipperChip) || null,
          cargoType:    f.cargoType     || null,
          deliveryCity: f.deliveryCity  || null,
          deliveryDist: f.deliveryDist  || null,
          workShift:    (shiftChip  === '직접입력' ? shiftCustom  : shiftChip)  || null,
          monthlyIncome:f.monthlyIncome || null,
          cargoNote:    f.cargoNote     || null,
        })),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        alert(err.error || '저장에 실패했습니다')
        return
      }
      setSaved(true)
      setMsg('저장되었습니다')
      setTimeout(() => setMsg(''), 2500)
    } finally {
      setSaving(false)
    }
  }

  const handleSaveActivity = async () => {
    setSavingAct(true)
    try {
      const res = await fetch(`/api/customers/${customer.id}/activities`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(act),
      })
      const saved = await res.json()
      setActivities(prev => [saved, ...prev])
      setAct({ type: '통화', date: new Date().toISOString().slice(0, 16), content: '', result: '', nextAction: '', assignee: '' })
      setShowActForm(false)
    } finally {
      setSavingAct(false)
    }
  }

  const handleDeleteActivity = async (id: string) => {
    await fetch(`/api/customers/${customer.id}/activities?activityId=${id}`, { method: 'DELETE' })
    setActivities(prev => prev.filter(a => a.id !== id))
  }

  const input = (k: string, ph = '') => (
    <input value={f[k as keyof typeof f] as string}
      onChange={e => setFv(k, e.target.value)}
      placeholder={ph}
      className={FIELD_CLS} />
  )

  const selectField = (k: string, opts: string[], placeholder = '선택 안 함') => (
    <select value={(f[k as keyof typeof f] as string) || ''} onChange={e => setFv(k, e.target.value)}
      className={FIELD_CLS}>
      <option value="">{placeholder}</option>
      {opts.map(o => <option key={o} value={o}>{o}</option>)}
    </select>
  )

  /* action이 있으면(예: "이름을 모를 때") 라벨 행에 함께 배치 — 있든 없든 행 높이가 항상 동일하게 유지된다 */
  const label = (text: string, action?: React.ReactNode) => (
    <div className="h-5 flex items-center justify-between mb-1.5">
      <label className="block text-[10px] font-bold text-slate-400 uppercase tracking-widest">{text}</label>
      {action}
    </div>
  )

  const sectionHead = (color: string, title: string, badge?: React.ReactNode) => (
    <SectionHeader color={color} title={title} action={badge} />
  )

  return (
    <div className="p-6 max-w-5xl mx-auto">
      {msg && (
        <div className="mb-4 px-4 py-2.5 rounded-lg bg-green-50 border border-green-200 text-green-700 text-sm font-medium">
          ✓ {msg}
        </div>
      )}

      {/* 리드 복귀 배너 */}
      {returnTo && (
        <div className="mb-4 flex items-center gap-3 px-4 py-2.5 bg-blue-50 border border-blue-200 rounded-xl">
          <span className="text-xs text-blue-600 flex-1">
            {f.customerSegment === 'B2B'
              ? '영업 리드 페이지에서 이동했습니다. 법인 정보 입력 후 돌아가세요.'
              : '영업 리드 페이지에서 이동했습니다. 차량/화주 정보 입력 후 돌아가세요.'}
          </span>
          <button
            onClick={() => router.push(returnTo)}
            className="text-xs font-semibold px-3 py-1.5 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors whitespace-nowrap">
            ← 리드로 돌아가기
          </button>
        </div>
      )}

      {/* 헤더 */}
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <Link href="/customers" className="text-slate-400 hover:text-slate-600 text-sm transition">← 고객 목록</Link>
          <div>
            <h1 className="text-2xl font-bold text-slate-800">{f.name || '이름 미입력'}</h1>
            <div className="flex items-center gap-2 mt-0.5">
              {customer.phone && <span className="text-sm text-slate-500">{customer.phone}</span>}
              <button type="button"
                onClick={() => {
                  if (!confirm(`고객 구분을 ${f.customerSegment === 'B2B' ? 'B2C 개인' : 'B2B 법인'}(으)로 변경할까요?`)) return
                  setFv('customerSegment', f.customerSegment === 'B2B' ? 'B2C' : 'B2B')
                }}
                title="클릭하여 B2B/B2C 구분 변경"
                className={`text-[10px] font-bold px-2.5 py-0.5 rounded-full transition hover:ring-2 hover:ring-offset-1
                ${f.customerSegment === 'B2B'
                  ? 'bg-violet-100 text-violet-700 hover:ring-violet-300'
                  : 'bg-sky-100 text-sky-700 hover:ring-sky-300'}`}>
                {f.customerSegment === 'B2B' ? 'B2B 법인' : 'B2C 개인'}
              </button>
              <span className="text-[10px] text-slate-400">
                등록 {new Date(customer.createdAt).toLocaleDateString('ko-KR')}
              </span>
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={async () => {
              if (!confirm(`"${f.name || '이름 미입력'}" 고객을 삭제할까요? 이 작업은 되돌릴 수 없습니다.`)) return
              await fetch(`/api/customers/${customer.id}`, { method: 'DELETE' })
              router.push('/customers')
            }}
            className="px-3 py-2 text-sm font-bold rounded-xl border border-red-200 text-red-400 hover:bg-red-50 hover:text-red-600 transition">
            삭제
          </button>
          <button onClick={handleSave} disabled={saving}
            className={`px-5 py-2 text-sm font-bold rounded-xl transition disabled:opacity-50
              ${saved ? 'bg-green-100 text-green-700 border border-green-200' : 'bg-slate-800 text-white hover:bg-slate-700'}`}>
            {saving ? '저장 중...' : saved ? '✓ 저장됨' : '저장하기'}
          </button>
        </div>
      </div>

      <div className="space-y-4">

          {/* ── B2C 통합 박스 ── */}
          {f.customerSegment !== 'B2B' && (
            <>
              {/* 기본 정보 */}
              <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
                {sectionHead('blue', '기본 정보')}
                <div className="p-5">
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    {label('고객명 *', (
                      <button type="button"
                        onClick={() => setFv('name', unknownCustomerName({
                          region:  f.regionDist || f.regionCity,
                          plateNo: f.vehiclePlateNo,
                          phone:   f.phone,
                        }))}
                        className={`text-[10px] font-semibold rounded-full px-2 py-0.5 transition ${
                          !f.name
                            ? 'text-amber-700 bg-amber-50 border border-amber-300 hover:bg-amber-100'
                            : 'text-slate-400 hover:text-slate-600 border border-slate-200'
                        }`}>
                        이름을 모를 때 · 신원미상
                      </button>
                    ))}
                    {input('name', '고객 이름')}
                  </div>
                  <div>{label('연락처')}{input('phone', '010-0000-0000')}</div>
                  <div>{label('이메일')}{input('email', 'example@email.com')}</div>
                  <div>
                    {label('영업 담당자')}
                    <AssigneePicker value={f.assignee} onChange={v => setFv('assignee', v)}
                      className={FIELD_CLS} />
                  </div>
                  <div>
                    {label('고객 분류')}
                    {selectField('customerCategory', ['자차지입', '임대지입', '용차', '월급기사'])}
                  </div>
                  <div>
                    {label('유입 경로')}
                    {selectField('source', SOURCES)}
                  </div>
                  <div className="col-span-2 flex items-end gap-3">
                    <div>
                      <label className="block text-[11px] font-semibold text-slate-400 mb-1.5 uppercase tracking-wide">소개인 여부</label>
                      <button type="button"
                        onClick={() => { setF(prev => ({ ...prev, isAgent: !prev.isAgent })); setSaved(false) }}
                        className={`flex items-center gap-2.5 px-4 py-2 rounded-xl text-sm font-semibold border transition-all
                          ${f.isAgent
                            ? 'bg-indigo-600 text-white border-indigo-600'
                            : 'bg-white text-slate-500 border-slate-200 hover:border-slate-400'}`}>
                        <span className={`w-4 h-4 rounded-full border-2 flex items-center justify-center transition-all
                          ${f.isAgent ? 'bg-white border-white' : 'border-slate-300'}`}>
                          {f.isAgent && <span className="w-2 h-2 rounded-full bg-indigo-600 block" />}
                        </span>
                        {f.isAgent ? '✓ 소개인 — 소개인 검색 시 포함됩니다' : '소개인'}
                      </button>
                    </div>
                    <div>
                      <label className="block text-[11px] font-semibold text-slate-400 mb-1.5 uppercase tracking-wide">입력일자</label>
                      <input type="date" value={f.collectedAt} onChange={e => setFv('collectedAt', e.target.value)}
                        placeholder="미입력 시 오늘 날짜"
                        className="text-sm border border-slate-200 rounded-xl px-3 py-2 focus:outline-none focus:ring-2 focus:ring-slate-300" />
                    </div>
                  </div>
                </div>
                </div>
              </div>

              {/* 개인 정보 */}
              <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
                {sectionHead('indigo', '개인 정보')}
                <div className="p-5">
                <div className="grid grid-cols-2 gap-4">
                  <div>{label('성별')}{selectField('gender', ['남', '여'])}</div>
                  <div>{label('결혼여부')}{selectField('maritalStatus', ['미혼', '기혼', '이혼'])}</div>
                  <div>
                    {label('생일 / 연령대')}
                    <input value={f.birthInfo} onChange={e => setFv('birthInfo', e.target.value)}
                      placeholder="예: 1985-03-15"
                      className="w-full text-sm border border-slate-200 rounded-lg px-3 py-2 bg-slate-50 focus:outline-none focus:ring-1 focus:ring-slate-300 focus:bg-white transition-colors mb-1.5" />
                    {selectField('birthInfo', ['10대', '20대', '30대', '40대', '50대', '60대+'], '또는 연령대 선택')}
                  </div>
                  <div>
                    {label('자녀 수')}
                    <input value={f.childrenCount} onChange={e => setFv('childrenCount', e.target.value.replace(/[^0-9]/g, ''))}
                      placeholder="0" className="w-full text-sm border border-slate-200 rounded-lg px-3 py-2 bg-slate-50 focus:outline-none focus:ring-1 focus:ring-slate-300 focus:bg-white transition-colors" />
                  </div>
                  <div>
                    {label('거주 지역 (시/도)')}
                    <select value={f.regionCity} onChange={e => { setFv('regionCity', e.target.value); setFv('regionDist', '') }}
                      className="w-full text-sm border border-slate-200 rounded-lg px-3 py-2 bg-slate-50 focus:outline-none focus:ring-1 focus:ring-slate-300 focus:bg-white transition-colors">
                      <option value="">시 / 도 선택</option>
                      {CITIES.map(c => <option key={c} value={c}>{c}</option>)}
                    </select>
                  </div>
                  <div>
                    {label('거주 지역 (시/군/구)')}
                    <select value={f.regionDist} onChange={e => setFv('regionDist', e.target.value)} disabled={!f.regionCity}
                      className="w-full text-sm border border-slate-200 rounded-lg px-3 py-2 bg-slate-50 focus:outline-none focus:ring-1 focus:ring-slate-300 focus:bg-white transition-colors disabled:bg-slate-100 disabled:text-slate-400">
                      <option value="">{f.regionCity ? '구 / 군 선택' : '시/도 먼저'}</option>
                      {(REGIONS[f.regionCity] ?? []).map(d => <option key={d} value={d}>{d}</option>)}
                    </select>
                  </div>
                  <div className="col-span-2">{label('주소')}{input('addressDetail', '상세 주소')}</div>
                  <div className="col-span-2">
                    {label('개인사업자 여부')}
                    <div className="flex gap-2 mb-3">
                      {([true, false] as const).map(v => (
                        <button key={String(v)} type="button"
                          onClick={() => { setF(p => ({ ...p, isSoleProprietor: p.isSoleProprietor === v ? null : v })); setSaved(false) }}
                          className={`px-3 py-1 rounded-lg text-xs font-semibold border transition ${f.isSoleProprietor === v ? 'bg-slate-800 text-white border-slate-800' : 'bg-white border-slate-200 text-slate-500 hover:border-slate-400'}`}>
                          {v ? '있음' : '없음'}
                        </button>
                      ))}
                    </div>
                    {f.isSoleProprietor && (
                      <div className="grid grid-cols-2 gap-3 p-3 bg-slate-50 rounded-lg border border-slate-100">
                        <div>{label('상호명')}{input('soleBusinessName', '상호명')}</div>
                        <div>{label('사업자등록번호')}{input('soleBusinessNo', '000-00-00000')}</div>
                        <div className="col-span-2">{label('업종')}{input('soleBusinessType', '예: 화물운송업')}</div>
                      </div>
                    )}
                  </div>
                </div>
                </div>
              </div>

              {/* 차량 정보 */}
              <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
                {sectionHead('amber', '차량 정보')}
                <div className="p-5">
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    {label('제조사')}
                    <select value={makerChip} onChange={e => { setMakerChip(e.target.value); setSaved(false) }}
                      className="w-full text-sm border border-slate-200 rounded-lg px-3 py-2 bg-slate-50 focus:outline-none focus:ring-1 focus:ring-slate-300 focus:bg-white transition-colors mb-1.5">
                      <option value="">선택 안 함</option>
                      {[...MAKER_CHIP_OPTS, '직접입력'].map(opt => <option key={opt} value={opt}>{opt}</option>)}
                    </select>
                    {makerChip === '직접입력' && (
                      <input value={makerCustom} onChange={e => { setMakerCustom(e.target.value); setSaved(false) }}
                        placeholder="제조사 직접 입력" className="w-full text-sm border border-slate-200 rounded-lg px-3 py-2 bg-slate-50 focus:outline-none focus:ring-1 focus:ring-slate-300 focus:bg-white transition-colors" />
                    )}
                  </div>
                  <div>{label('차량명')}{input('vehicleName', '예: 메가트럭, 파비스')}</div>
                  <div>
                    {label('차량번호')}
                    <input value={f.vehiclePlateNo} onChange={e => setFv('vehiclePlateNo', e.target.value)}
                      onBlur={e => { if (!hasPlateSpacing(e.target.value)) alert('차량번호 끝 4자리 앞에 띄어쓰기를 추가해주세요. (예: 97보 8003)') }}
                      placeholder="예: 97보 8003"
                      className="w-full text-sm border border-slate-200 rounded-lg px-3 py-2 bg-slate-50 focus:outline-none focus:ring-1 focus:ring-slate-300 focus:bg-white transition-colors" />
                  </div>
                  <div>{label('연식')}{input('vehicleYear', '예: 2020')}</div>
                  <div>
                    {label('주행거리 (km)')}
                    <input value={f.totalMileage} onChange={e => { const n = e.target.value.replace(/[^0-9]/g, ''); setF(p => ({ ...p, totalMileage: n ? Number(n).toLocaleString() : '' })); setSaved(false) }}
                      placeholder="예: 150,000" className="w-full text-sm border border-slate-200 rounded-lg px-3 py-2 bg-slate-50 focus:outline-none focus:ring-1 focus:ring-slate-300 focus:bg-white transition-colors" />
                  </div>
                  <div className="col-span-2">
                    {label('차종 분류')}
                    <div className="grid grid-cols-2 gap-3">
                      <div><p className="text-[10px] text-slate-400 mb-1">구분1 · 형태</p>{selectField('truckType1', ['탑', '벤', '오픈배드'])}</div>
                      <div><p className="text-[10px] text-slate-400 mb-1">구분2 · 연료</p>{selectField('truckType2', ['경유', '가스', '전기'])}</div>
                      <div><p className="text-[10px] text-slate-400 mb-1">구분3 · 적재함</p>{selectField('truckType3', ['건탑', '냉동', '냉장'])}</div>
                      <div><p className="text-[10px] text-slate-400 mb-1">구분4 · 높이</p>{selectField('truckType4', ['저상', '표준', '하이탑'])}</div>
                    </div>
                  </div>
                  <div className="col-span-2">
                    {label('차량 사진')}
                    {(() => {
                      const doc = docs.find(d => d.type === '차량사진')
                      const isUploading = uploading === '차량사진'
                      return (
                        <div className="flex items-center gap-3">
                          {doc && (
                            <a href={doc.path} target="_blank" rel="noreferrer" className="shrink-0">
                              <img src={doc.path} alt="차량 사진"
                                className="w-16 h-16 object-cover rounded-lg border border-slate-200" />
                            </a>
                          )}
                          <label className={`cursor-pointer px-3 py-1.5 text-xs font-semibold rounded-lg border transition
                            ${isUploading ? 'opacity-50 cursor-not-allowed' : 'border-slate-200 text-slate-600 hover:bg-slate-50 hover:border-slate-400'}`}>
                            {isUploading ? '업로드 중...' : doc ? '재업로드' : '사진 업로드'}
                            <input type="file" className="hidden" disabled={isUploading}
                              accept=".jpg,.jpeg,.png,.heic"
                              onChange={e => { const file = e.target.files?.[0]; if (file) handleDocUpload('차량사진', file); e.target.value = '' }} />
                          </label>
                          {doc && (
                            <button type="button" onClick={() => handleDocDelete('차량사진')}
                              className="text-[10px] text-red-400 hover:text-red-600 transition font-semibold">
                              삭제
                            </button>
                          )}
                        </div>
                      )
                    })()}
                  </div>
                </div>
                </div>
              </div>

              {/* 화주 정보 */}
              <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
                {sectionHead('emerald', '화주 정보')}
                <div className="p-5">
                <div className="grid grid-cols-2 gap-4">
                  <div className="col-span-2">
                    {label('화주명')}
                    <select value={shipperChip} onChange={e => { setShipperChip(e.target.value); setSaved(false) }}
                      className="w-full text-sm border border-slate-200 rounded-lg px-3 py-2 bg-slate-50 focus:outline-none focus:ring-1 focus:ring-slate-300 focus:bg-white transition-colors mb-1.5">
                      <option value="">선택 안 함</option>
                      {[...SHIPPER_PRESETS, '직접입력'].map(opt => <option key={opt} value={opt}>{opt}</option>)}
                    </select>
                    {shipperChip === '직접입력' && (
                      <input value={shipperCustom} onChange={e => { setShipperCustom(e.target.value); setSaved(false) }}
                        placeholder="화주명 직접 입력" className="w-full text-sm border border-slate-200 rounded-lg px-3 py-2 bg-slate-50 focus:outline-none focus:ring-1 focus:ring-slate-300 focus:bg-white transition-colors" />
                    )}
                  </div>
                  <div>{label('화물 유형')}{input('cargoType', '예: 냉동식품, 공산품')}</div>
                  <div />
                  <div>
                    {label('배송 지역 (시/도)')}
                    <select value={f.deliveryCity} onChange={e => { setFv('deliveryCity', e.target.value); setFv('deliveryDist', '') }}
                      className="w-full text-sm border border-slate-200 rounded-lg px-3 py-2 bg-slate-50 focus:outline-none focus:ring-1 focus:ring-slate-300 focus:bg-white transition-colors">
                      <option value="">시 / 도 선택</option>
                      {CITIES.map(c => <option key={c} value={c}>{c}</option>)}
                    </select>
                  </div>
                  <div>
                    {label('배송 지역 (시/군/구)')}
                    <select value={f.deliveryDist} onChange={e => setFv('deliveryDist', e.target.value)} disabled={!f.deliveryCity}
                      className="w-full text-sm border border-slate-200 rounded-lg px-3 py-2 bg-slate-50 focus:outline-none focus:ring-1 focus:ring-slate-300 focus:bg-white transition-colors disabled:bg-slate-100 disabled:text-slate-400">
                      <option value="">{f.deliveryCity ? '구 / 군 선택' : '시/도 먼저'}</option>
                      {(REGIONS[f.deliveryCity] ?? []).map(d => <option key={d} value={d}>{d}</option>)}
                    </select>
                  </div>
                  <div>
                    {label('근무 패턴')}
                    <select value={shiftChip} onChange={e => { setShiftChip(e.target.value); setSaved(false) }}
                      className="w-full text-sm border border-slate-200 rounded-lg px-3 py-2 bg-slate-50 focus:outline-none focus:ring-1 focus:ring-slate-300 focus:bg-white transition-colors mb-1.5">
                      <option value="">선택 안 함</option>
                      {[...SHIFT_PRESETS, '직접입력'].map(opt => <option key={opt} value={opt}>{opt}</option>)}
                    </select>
                    {shiftChip === '직접입력' && (
                      <input value={shiftCustom} onChange={e => { setShiftCustom(e.target.value); setSaved(false) }}
                        placeholder="예: 새벽배송" className="w-full text-sm border border-slate-200 rounded-lg px-3 py-2 bg-slate-50 focus:outline-none focus:ring-1 focus:ring-slate-300 focus:bg-white transition-colors" />
                    )}
                  </div>
                  <div>{label('월 수입 (만원)')}{input('monthlyIncome', '예: 350')}</div>
                  <div className="col-span-2">
                    {label('화물 특이사항')}
                    <textarea value={f.cargoNote} rows={2} onChange={e => setFv('cargoNote', e.target.value)}
                      placeholder="온도 조건, 하역 방식, 특수 요구사항 등..."
                      className="w-full text-sm border border-slate-200 rounded-lg px-3 py-2 resize-none bg-slate-50 focus:outline-none focus:ring-1 focus:ring-slate-300 focus:bg-white transition-colors" />
                  </div>
                </div>
                </div>
              </div>
            </>
          )}

          {/* ── B2B 통합 박스 ── */}
          {f.customerSegment === 'B2B' && (
            <>
              {/* 기본 정보 */}
              <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
                {sectionHead('violet', '기본 정보')}
                <div className="p-5">
                <div className="grid grid-cols-2 gap-4">
                  <div>{label('거래처 담당자명 *')}{input('name', '거래처 담당자 이름')}</div>
                  <div>{label('거래처 담당자 연락처')}{input('phone', '010-0000-0000')}</div>
                  <div>{label('이메일')}{input('email', 'example@email.com')}</div>
                  <div>
                    {label('거래처 담당자 직위')}
                    <select value={f.contactTitle ?? ''} onChange={e => setFv('contactTitle', e.target.value)}
                      className="w-full text-sm border border-slate-200 rounded-lg px-3 py-2 bg-slate-50 focus:outline-none focus:ring-1 focus:ring-slate-300 focus:bg-white transition-colors text-slate-700">
                      <option value="">직위 선택</option>
                      {CONTACT_TITLES.map(t => <option key={t} value={t}>{t}</option>)}
                    </select>
                  </div>
                  <div>
                    <label className="block text-[11px] font-semibold text-slate-400 mb-1.5 uppercase tracking-wide">명함</label>
                    <div className="flex items-center gap-2">
                      {mainCardUrl ? (
                        <a href={mainCardUrl} target="_blank" rel="noreferrer" className="shrink-0">
                          <img src={mainCardUrl} alt="명함" className="w-14 h-9 object-cover rounded border border-slate-200" />
                        </a>
                      ) : (
                        <div className="w-14 h-9 rounded border border-dashed border-slate-200 flex items-center justify-center text-[9px] text-slate-300 shrink-0">없음</div>
                      )}
                      <label className={`cursor-pointer px-3 py-1.5 text-xs font-semibold rounded-lg border transition
                        ${mainCardUploading ? 'opacity-50 cursor-not-allowed' : 'border-slate-200 text-slate-600 hover:bg-white hover:border-slate-400'}`}>
                        {mainCardUploading ? '업로드 중...' : mainCardUrl ? '재업로드' : '업로드'}
                        <input type="file" className="hidden" disabled={mainCardUploading} accept="image/*"
                          onChange={e => { const file = e.target.files?.[0]; if (file) handleMainCardUpload(file); e.target.value = '' }} />
                      </label>
                      {mainCardUrl && (
                        <button type="button" onClick={handleMainCardDelete}
                          className="text-[10px] text-red-400 hover:text-red-600 transition font-semibold">삭제</button>
                      )}
                    </div>
                  </div>
                  <div>{label('회사 / 법인명')}{input('companyName', '회사명')}</div>
                  <div>{label('사업자등록번호')}{input('businessRegNo', '000-00-00000')}</div>
                  <div>
                    {label('고객분류')}
                    <select value={industryChip} onChange={e => { setIndustryChip(e.target.value); setSaved(false) }}
                      className="w-full text-sm border border-slate-200 rounded-lg px-3 py-2 bg-slate-50 focus:outline-none focus:ring-1 focus:ring-slate-300 focus:bg-white transition-colors mb-1.5">
                      <option value="">선택 안 함</option>
                      {INDUSTRY_CHIPS.map(opt => <option key={opt} value={opt}>{opt}</option>)}
                    </select>
                    {industryChip === '기타' && (
                      <input value={industryCustom} onChange={e => { setIndustryCustom(e.target.value); setSaved(false) }}
                        placeholder="직접 입력" className="w-full text-sm border border-slate-200 rounded-lg px-3 py-2 bg-slate-50 focus:outline-none focus:ring-1 focus:ring-slate-300 focus:bg-white transition-colors" />
                    )}
                  </div>
                  <div>{label('회사 전화')}{input('companyPhone', '02-0000-0000')}</div>
                  <div className="col-span-2">{label('회사 주소')}{input('companyAddress', '본사 주소')}</div>
                  <div>
                    {label('직원수')}
                    <div className="flex items-center gap-2">
                      {input('employeeCount', '0')}
                      <span className="text-xs font-semibold text-slate-400 shrink-0">명</span>
                    </div>
                  </div>
                  <div className="col-span-2">
                    {label('유입 경로')}
                    {selectField('source', SOURCES)}
                  </div>
                  <div className="col-span-2 flex items-end gap-3">
                    <div>
                      <label className="block text-[11px] font-semibold text-slate-400 mb-1.5 uppercase tracking-wide">소개인 여부</label>
                      <button type="button"
                        onClick={() => { setF(prev => ({ ...prev, isAgent: !prev.isAgent })); setSaved(false) }}
                        className={`flex items-center gap-2.5 px-4 py-2 rounded-xl text-sm font-semibold border transition-all
                          ${f.isAgent
                            ? 'bg-violet-600 text-white border-violet-600'
                            : 'bg-white text-slate-500 border-slate-200 hover:border-slate-400'}`}>
                        <span className={`w-4 h-4 rounded-full border-2 flex items-center justify-center transition-all
                          ${f.isAgent ? 'bg-white border-white' : 'border-slate-300'}`}>
                          {f.isAgent && <span className="w-2 h-2 rounded-full bg-violet-600 block" />}
                        </span>
                        {f.isAgent ? '✓ 법인 소개인 — 소개인 검색 시 포함됩니다' : '소개인(법인)'}
                      </button>
                    </div>
                    <div>
                      <label className="block text-[11px] font-semibold text-slate-400 mb-1.5 uppercase tracking-wide">입력일자</label>
                      <input type="date" value={f.collectedAt} onChange={e => setFv('collectedAt', e.target.value)}
                        placeholder="미입력 시 오늘 날짜"
                        className="text-sm border border-slate-200 rounded-xl px-3 py-2 focus:outline-none focus:ring-2 focus:ring-slate-300" />
                    </div>
                  </div>
                  <div>
                    {label('영업 담당자')}
                    <AssigneePicker value={f.assignee} onChange={v => setFv('assignee', v)}
                      className="w-full text-sm border border-slate-200 rounded-lg px-3 py-2 bg-slate-50 focus:outline-none focus:ring-1 focus:ring-slate-300 focus:bg-white transition-colors" />
                  </div>
                </div>
                </div>
              </div>

              {/* 관계자 목록 */}
              <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
                {sectionHead('sky', '관계자 목록')}
                <div className="p-5">
                <div className="overflow-x-auto">
                  <div style={{ minWidth: 760 }}>
                    <div className="grid gap-2 mb-1" style={{ gridTemplateColumns: '1fr 110px 90px 1fr 140px 1fr 76px 24px' }}>
                      <span className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">이름</span>
                      <span className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">전화번호</span>
                      <span className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">직위</span>
                      <span className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">담당업무</span>
                      <span className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">이메일</span>
                      <span className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">비고</span>
                      <span className="text-[10px] font-bold text-slate-400 uppercase tracking-widest text-center">명함</span>
                      <span />
                    </div>
                    <div className="space-y-2">
                      {contacts.map(c => (
                        <div key={c.id} className="grid gap-2 items-center" style={{ gridTemplateColumns: '1fr 110px 90px 1fr 140px 1fr 76px 24px' }}>
                          <input value={c.name} onChange={e => updateContact(c.id, { name: e.target.value })}
                            placeholder="이름" className="w-full text-sm border border-slate-200 rounded-lg px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-slate-300" />
                          <input value={c.phone} onChange={e => updateContact(c.id, { phone: formatPhone(e.target.value) })}
                            placeholder="010-0000-0000" className="w-full text-sm border border-slate-200 rounded-lg px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-slate-300" />
                          <input value={c.title} onChange={e => updateContact(c.id, { title: e.target.value })}
                            placeholder="직위" className="w-full text-sm border border-slate-200 rounded-lg px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-slate-300" />
                          <input value={c.role} onChange={e => updateContact(c.id, { role: e.target.value })}
                            placeholder="담당업무" className="w-full text-sm border border-slate-200 rounded-lg px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-slate-300" />
                          <input value={c.email} onChange={e => updateContact(c.id, { email: e.target.value })}
                            placeholder="example@email.com" className="w-full text-sm border border-slate-200 rounded-lg px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-slate-300" />
                          <input value={c.note} onChange={e => updateContact(c.id, { note: e.target.value })}
                            placeholder="비고" className="w-full text-sm border border-slate-200 rounded-lg px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-slate-300" />
                          <div className="flex items-center justify-center">
                            {c.cardUrl ? (
                              <div className="flex items-center gap-1">
                                <a href={c.cardUrl} target="_blank" rel="noreferrer">
                                  <img src={c.cardUrl} alt="명함" className="w-10 h-7 object-cover rounded border border-slate-200" />
                                </a>
                                <button type="button" onClick={() => handleContactCardDelete(c.id)}
                                  className="text-[10px] text-red-400 hover:text-red-600 transition">✕</button>
                              </div>
                            ) : (
                              <label className={`flex items-center justify-center w-10 h-7 rounded border border-dashed text-[9px] transition
                                ${contactUploading === c.id ? 'opacity-50 cursor-not-allowed border-slate-200 text-slate-300' : 'cursor-pointer border-slate-300 text-slate-400 hover:border-slate-400 hover:text-slate-600'}`}>
                                {contactUploading === c.id ? '...' : '업로드'}
                                <input type="file" className="hidden" accept="image/*" disabled={contactUploading === c.id}
                                  onChange={e => { const file = e.target.files?.[0]; if (file) handleContactCardUpload(c.id, file); e.target.value = '' }} />
                              </label>
                            )}
                          </div>
                          <button type="button" onClick={() => removeContact(c.id)}
                            className="flex items-center justify-center w-6 h-6 rounded-md text-slate-300 hover:text-red-400 hover:bg-red-50 transition">
                            ✕
                          </button>
                        </div>
                      ))}
                    </div>
                    {contacts.length === 0 && (
                      <p className="text-xs text-slate-400 text-center py-3">등록된 관계자가 없습니다</p>
                    )}
                  </div>
                </div>
                <button type="button" onClick={addContact}
                  className="mt-2 w-full py-1.5 text-xs font-semibold text-slate-400 border border-dashed border-slate-200 rounded-lg hover:border-slate-400 hover:text-slate-600 transition">
                  + 관계자 추가
                </button>
                </div>
              </div>

              {/* 보유차량 + 법인매출 좌우 배치 */}
              <div className="grid grid-cols-2 gap-4">

                {/* 보유 차량 정보 */}
                <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
                  {sectionHead('amber', '보유 차량 정보')}
                  <div className="p-5">
                  <div className="grid gap-2 mb-1" style={{ gridTemplateColumns: '1fr 56px 24px' }}>
                    <span className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">차량명</span>
                    <span className="text-[10px] font-bold text-slate-400 uppercase tracking-widest text-center">대수</span>
                    <span />
                  </div>
                  <div className="space-y-2">
                    {vehicleList.map((row, i) => (
                      <div key={i} className="grid gap-2 items-center" style={{ gridTemplateColumns: '1fr 56px 24px' }}>
                        <input
                          value={row.name}
                          onChange={e => { setVehicleList(prev => prev.map((r, idx) => idx === i ? { ...r, name: e.target.value } : r)); setSaved(false) }}
                          placeholder="예: 메가트럭"
                          className="w-full text-sm border border-slate-200 rounded-lg px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-slate-300" />
                        <input
                          value={row.count}
                          onChange={e => { setVehicleList(prev => prev.map((r, idx) => idx === i ? { ...r, count: e.target.value.replace(/[^0-9]/g, '') } : r)); setSaved(false) }}
                          placeholder="0"
                          className="w-full text-sm border border-slate-200 rounded-lg px-2 py-1.5 text-center focus:outline-none focus:ring-1 focus:ring-slate-300" />
                        <button
                          type="button"
                          onClick={() => { setVehicleList(prev => prev.length > 1 ? prev.filter((_, idx) => idx !== i) : prev); setSaved(false) }}
                          className="flex items-center justify-center w-6 h-6 rounded-md text-slate-300 hover:text-red-400 hover:bg-red-50 transition"
                          disabled={vehicleList.length <= 1}>
                          ✕
                        </button>
                      </div>
                    ))}
                  </div>
                  <button
                    type="button"
                    onClick={() => { setVehicleList(prev => [...prev, { name: '', count: '' }]); setSaved(false) }}
                    className="mt-2 w-full py-1.5 text-xs font-semibold text-slate-400 border border-dashed border-slate-200 rounded-lg hover:border-slate-400 hover:text-slate-600 transition">
                    + 열 추가
                  </button>
                  <div className="mt-2 flex items-center justify-between px-3 py-2 bg-slate-50 rounded-lg border border-slate-100">
                    <span className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">총합</span>
                    <span className="text-sm font-bold text-slate-700">
                      {vehicleList.reduce((s, r) => s + (parseInt(r.count) || 0), 0) > 0
                        ? `${vehicleList.reduce((s, r) => s + (parseInt(r.count) || 0), 0).toLocaleString()} 대`
                        : '—'}
                    </span>
                  </div>
                  </div>
                </div>

                {/* 법인 매출 */}
                <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
                  {sectionHead('emerald', '법인 매출')}
                  <div className="p-5">
                  <div className="space-y-2">
                    {([
                      { key: 'b2bRevenue1', year: new Date().getFullYear() - 1 },
                      { key: 'b2bRevenue2', year: new Date().getFullYear() - 2 },
                      { key: 'b2bRevenue3', year: new Date().getFullYear() - 3 },
                    ] as { key: 'b2bRevenue1' | 'b2bRevenue2' | 'b2bRevenue3'; year: number }[]).map(({ key, year }) => (
                      <div key={key} className="grid items-center gap-2" style={{ gridTemplateColumns: '60px 1fr auto' }}>
                        <span className="text-xs font-bold text-slate-500 text-right">{year}년</span>
                        <input
                          value={f[key]}
                          onChange={e => { setF(p => ({ ...p, [key]: e.target.value })); setSaved(false) }}
                          placeholder="0"
                          className="w-full text-sm border border-slate-200 rounded-lg px-2 py-1.5 text-right focus:outline-none focus:ring-1 focus:ring-slate-300"
                        />
                        <span className="text-xs font-semibold text-slate-400">억</span>
                      </div>
                    ))}
                  </div>
                  </div>
                </div>

              </div>
            </>
          )}

          {/* B2B 첨부 서류 */}
          {f.customerSegment === 'B2B' && (
            <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
              {sectionHead('slate', '첨부 서류')}
              <div className="p-5">
              <div className="space-y-3">
                {(['사업자등록증', '계좌정보'] as const).map(docType => {
                  const doc = docs.find(d => d.type === docType)
                  const isUploading = uploading === docType
                  return (
                    <div key={docType} className="flex items-center justify-between gap-3 px-4 py-3 rounded-lg border border-slate-100 bg-slate-50">
                      <div className="flex items-center gap-3 min-w-0">
                        <span className="text-[10px] font-bold text-slate-500 uppercase tracking-widest whitespace-nowrap">{docType}</span>
                        {doc ? (
                          <a href={doc.path} target="_blank" rel="noreferrer"
                            className="text-xs text-blue-600 hover:underline truncate max-w-[200px]" title={doc.name}>
                            {doc.name}
                          </a>
                        ) : (
                          <span className="text-xs text-slate-400">미업로드</span>
                        )}
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        {doc && (
                          <button type="button" onClick={() => handleDocDelete(docType)}
                            className="text-[10px] text-red-400 hover:text-red-600 transition font-semibold">
                            삭제
                          </button>
                        )}
                        <label className={`cursor-pointer px-3 py-1.5 text-xs font-semibold rounded-lg border transition
                          ${isUploading ? 'opacity-50 cursor-not-allowed' : 'border-slate-200 text-slate-600 hover:bg-white hover:border-slate-400'}`}>
                          {isUploading ? '업로드 중...' : doc ? '재업로드' : '업로드'}
                          <input type="file" className="hidden" disabled={isUploading}
                            accept=".pdf,.jpg,.jpeg,.png,.heic"
                            onChange={e => { const f = e.target.files?.[0]; if (f) handleDocUpload(docType, f); e.target.value = '' }} />
                        </label>
                      </div>
                    </div>
                  )
                })}
              </div>
              <p className="mt-3 text-[10px] text-slate-400">PDF, JPG, PNG, HEIC 지원 · 파일당 최대 10MB</p>
              </div>
            </div>
          )}

          {/* 메모 (공통) */}
          <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
            {sectionHead('slate', '메모')}
            <div className="p-5">
            <textarea value={f.memo} rows={4} onChange={e => setFv('memo', e.target.value)}
              placeholder="고객 특이사항, 니즈 등..."
              className="w-full text-sm border border-slate-200 rounded-lg px-3 py-2 resize-none bg-slate-50 focus:outline-none focus:ring-1 focus:ring-slate-300 focus:bg-white transition-colors" />
            </div>
          </div>

      </div>

      {/* 활동 이력 */}
      <div className="mt-4 bg-white rounded-xl border border-slate-200 overflow-hidden">
        <div className="px-5 py-3 bg-teal-600 flex items-center justify-between">
          <h3 className="text-white font-bold text-sm">영업 활동 이력</h3>
          <button onClick={() => setShowActForm(v => !v)}
            className={`px-3 py-1.5 text-xs font-semibold rounded-lg transition
              ${showActForm ? 'bg-white/90 text-slate-700 hover:bg-white' : 'bg-white/10 hover:bg-white/20 text-white'}`}>
            {showActForm ? '취소' : '+ 활동 추가'}
          </button>
        </div>
        <div className="p-5">

        {/* 활동 추가 폼 */}
        {showActForm && (
          <div className="mb-5 p-5 bg-slate-50 rounded-xl border border-slate-200">
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1.5">유형</label>
                <div className="flex gap-1.5 flex-wrap">
                  {['통화', '방문', '이메일', '문자', '기타'].map(t => (
                    <button key={t} onClick={() => setAct(a => ({ ...a, type: t }))}
                      className={`px-3 py-1 rounded-lg text-xs font-semibold border transition
                        ${act.type === t ? 'bg-slate-800 text-white border-slate-800' : 'bg-white border-slate-200 text-slate-500 hover:border-slate-400'}`}>
                      {t}
                    </button>
                  ))}
                </div>
              </div>
              <div>
                <label className="block text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1.5">일시</label>
                <input type="datetime-local" value={act.date}
                  onChange={e => setAct(a => ({ ...a, date: e.target.value }))}
                  className="w-full text-xs border border-slate-200 rounded-lg px-3 py-2 bg-slate-50 focus:outline-none focus:ring-1 focus:ring-slate-300 focus:bg-white transition-colors" />
              </div>
              <div className="col-span-2">
                <label className="block text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1.5">내용</label>
                <textarea value={act.content} rows={2}
                  onChange={e => setAct(a => ({ ...a, content: e.target.value }))}
                  placeholder="활동 내용..."
                  className="w-full text-xs border border-slate-200 rounded-lg px-3 py-2 bg-white resize-none focus:outline-none focus:ring-1 focus:ring-slate-300" />
              </div>
              <div>
                <label className="block text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1.5">결과</label>
                <input value={act.result}
                  onChange={e => setAct(a => ({ ...a, result: e.target.value }))}
                  placeholder="예: 관심 표명, 재연락 약속"
                  className="w-full text-xs border border-slate-200 rounded-lg px-3 py-2 bg-slate-50 focus:outline-none focus:ring-1 focus:ring-slate-300 focus:bg-white transition-colors" />
              </div>
              <div>
                <label className="block text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1.5">다음 액션</label>
                <input value={act.nextAction}
                  onChange={e => setAct(a => ({ ...a, nextAction: e.target.value }))}
                  placeholder="예: 자료 발송, 방문 일정"
                  className="w-full text-xs border border-slate-200 rounded-lg px-3 py-2 bg-slate-50 focus:outline-none focus:ring-1 focus:ring-slate-300 focus:bg-white transition-colors" />
              </div>
            </div>
            <div className="mt-4 flex justify-end">
              <button onClick={handleSaveActivity} disabled={savingAct}
                className="px-5 py-2 text-xs font-bold rounded-lg bg-slate-800 text-white hover:bg-slate-700 transition disabled:opacity-40">
                {savingAct ? '저장 중...' : '기록 저장'}
              </button>
            </div>
          </div>
        )}

        {activities.length === 0 ? (
          <div className="text-center py-10 text-slate-300 text-sm border border-dashed border-slate-200 rounded-xl">
            아직 활동 이력이 없습니다
          </div>
        ) : (
          <div className="space-y-3">
            {activities.map(a => (
              <div key={a.id} className="p-4 bg-white rounded-xl border border-slate-200 hover:border-slate-300 transition">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${ACT_COLOR[a.type] ?? 'bg-slate-100 text-slate-500'}`}>
                      {a.type}
                    </span>
                    <span className="text-xs font-semibold text-slate-700">
                      {new Date(a.date).toLocaleDateString('ko-KR', { month: 'long', day: 'numeric' })}
                      {' '}
                      {new Date(a.date).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })}
                    </span>
                    {a.assignee && <span className="text-[10px] text-slate-400">· {a.assignee}</span>}
                  </div>
                  <button onClick={() => handleDeleteActivity(a.id)}
                    className="text-slate-300 hover:text-red-400 transition text-xs shrink-0">삭제</button>
                </div>
                {a.content && <p className="mt-2 text-xs text-slate-700 whitespace-pre-wrap">{a.content}</p>}
                <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
                  {a.result     && <span className="text-[11px] text-slate-500"><span className="font-semibold text-slate-400">결과 </span>{a.result}</span>}
                  {a.nextAction && <span className="text-[11px] text-blue-600"><span className="font-semibold">→ </span>{a.nextAction}</span>}
                </div>
              </div>
            ))}
          </div>
        )}
        </div>
      </div>
    </div>
  )
}
