import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'

export async function GET(req: NextRequest) {
  const url  = new URL(req.url)
  const q    = url.searchParams.get('q')?.trim()
  const mode = url.searchParams.get('mode') // 'name' | 'phone' | 'company' | 'plate' | null(both)

  // 전화번호 검색 시 숫자만 추출해 비교 (하이픈 무관)
  const digitsOnly = q?.replace(/\D/g, '')

  const customers = await prisma.customer.findMany({
    where: q
      ? mode === 'phone'
        ? { OR: [
            { phone: { contains: q } },
            ...(digitsOnly ? [{ phone: { contains: digitsOnly } }] : []),
            { contactsJson: { contains: q } },
            ...(digitsOnly ? [{ contactsJson: { contains: digitsOnly } }] : []),
          ] }
        : mode === 'name'
          ? { OR: [
              { name: { contains: q } },
              { contactsJson: { contains: q } },
            ] }
          : mode === 'company'
            ? { OR: [
                { companyName:      { contains: q } },
                { soleBusinessName: { contains: q } },
              ] }
            : mode === 'plate'
              ? { vehiclePlateNo: { contains: q } }
              : { OR: [
                  { name:        { contains: q } },
                  { phone:       { contains: q } },
                  { companyName: { contains: q } },
                  { contactsJson: { contains: q } },
                ] }
      : undefined,
    orderBy: { createdAt: 'desc' },
    include: {
      activities: { select: { id: true, date: true, type: true }, orderBy: { date: 'desc' }, take: 1 },
    },
  })
  return NextResponse.json(customers)
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    // 빠른 고객 추가 — 상세 페이지에서 이름을 채우는 것을 전제로 이름 없이 생성 허용
    if (!body.allowBlankName && !body.name?.trim()) {
      return NextResponse.json({ error: '고객명은 필수입니다.' }, { status: 400 })
    }

    // 동일 전화번호의 고객이 이미 있으면 중복 생성 방지를 위해 저장 자체를 차단한다.
    if (body.phone) {
      const dup = await prisma.customer.findFirst({
        where: { phone: body.phone },
        select: { id: true, name: true },
      })
      if (dup) {
        return NextResponse.json(
          { error: `이미 등록된 전화번호입니다 (기존 고객: ${dup.name || '이름없음'})` },
          { status: 409 },
        )
      }
    }

    const customer = await prisma.customer.create({
      data: {
        name:             body.name?.trim() ?? '',
        phone:            body.phone            || null,
        email:            body.email            || null,
        customerSegment:  body.customerSegment  || null,
        customerCategory: body.customerCategory || null,
        status:           body.status           || '잠재고객',
        grade:            body.grade            || null,
        source:           body.source           || null,
        collectedAt:      body.collectedAt ? new Date(body.collectedAt) : null,
        assignee:         body.assignee         || null,
        memo:             body.memo             || null,
        regionCity:       body.regionCity       || null,
        regionDist:       body.regionDist       || null,
        gender:           body.gender           || null,
        birthInfo:        body.birthInfo        || null,
        maritalStatus:    body.maritalStatus    || null,
        childrenCount:    body.childrenCount    ?? null,
        addressDetail:    body.addressDetail    || null,
        isSoleProprietor: body.isSoleProprietor ?? null,
        soleBusinessName: body.soleBusinessName || null,
        soleBusinessNo:   body.soleBusinessNo   || null,
        soleBusinessType: body.soleBusinessType || null,
        b2bCategory:      body.b2bCategory      || null,
        companyName:      body.companyName      || null,
        businessRegNo:    body.businessRegNo    || null,
        contactTitle:     body.contactTitle     || null,
        industry:         body.industry         || null,
        companyAddress:   body.companyAddress   || null,
        companyPhone:     body.companyPhone     || null,
        vehicleMaker:     body.vehicleMaker     || null,
        vehicleName:      body.vehicleName      || null,
        vehiclePlateNo:   body.vehiclePlateNo   || null,
        vehicleYear:      body.vehicleYear      || null,
        totalMileage:     body.totalMileage     ?? null,
        truckType1:       body.truckType1       || null,
        truckType2:       body.truckType2       || null,
        truckType3:       body.truckType3       || null,
        truckType4:       body.truckType4       || null,
        shipperName:      body.shipperName      || null,
        cargoType:        body.cargoType        || null,
        deliveryCity:     body.deliveryCity     || null,
        deliveryDist:     body.deliveryDist     || null,
        deliveryFreq:     body.deliveryFreq     || null,
        workShift:        body.workShift        || null,
        monthlyIncome:    body.monthlyIncome    || null,
        cargoNote:        body.cargoNote        || null,
      },
    })
    return NextResponse.json(customer, { status: 201 })
  } catch {
    return NextResponse.json({ error: '생성 실패' }, { status: 500 })
  }
}
