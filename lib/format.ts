/**
 * 숫자만 추출해 한국 전화번호 형식으로 변환
 * 010-1234-5678 / 02-1234-5678 / 0XX-123-4567
 */
export function formatPhone(value: string): string {
  const digits = value.replace(/\D/g, '').slice(0, 11)
  if (!digits) return ''

  if (digits.startsWith('02')) {
    if (digits.length <= 2)  return digits
    if (digits.length <= 5)  return `${digits.slice(0, 2)}-${digits.slice(2)}`
    if (digits.length <= 9)  return `${digits.slice(0, 2)}-${digits.slice(2, 5)}-${digits.slice(5)}`
    return                          `${digits.slice(0, 2)}-${digits.slice(2, 6)}-${digits.slice(6)}`
  }

  if (digits.length <= 3)  return digits
  if (digits.length <= 6)  return `${digits.slice(0, 3)}-${digits.slice(3)}`
  if (digits.length <= 10) return `${digits.slice(0, 3)}-${digits.slice(3, 6)}-${digits.slice(6)}`
  return                          `${digits.slice(0, 3)}-${digits.slice(3, 7)}-${digits.slice(7)}`
}

/**
 * 차량번호 끝자리(4자리 숫자) 앞에 띄어쓰기가 있는지 확인.
 * 4자리로 끝나지 않는 값(빈 값, 형식 다름 등)은 검사하지 않고 통과시킨다.
 */
export function hasPlateSpacing(value: string): boolean {
  const trimmed = value.trim()
  const m = trimmed.match(/^(.*?)(\d{4})$/)
  if (!m) return true
  const prefix = m[1]
  return prefix.length === 0 || prefix.endsWith(' ')
}

/** 차량번호에서 끝 4자리 숫자만 추출 (구분 형태와 무관하게 동작) */
export function plateLast4(value: string): string {
  return value.replace(/\D/g, '').slice(-4)
}

/** 전화번호에서 끝 4자리 숫자만 추출 */
export function phoneLast4(value: string): string {
  return value.replace(/\D/g, '').slice(-4)
}

/**
 * 신원미상 고객명 자동 생성.
 * 전화번호가 있으면 "미상(📞 전화끝4자리)", 없으면 차량번호가 있을 때 "미상(🚚 차량번호끝4자리)",
 * 둘 다 없으면 "미상"만 반환한다. (전화번호를 차량번호보다 우선)
 * 주소지(지역)를 알고 있으면 두 경우 모두 앞에 지역명을 붙인다.
 */
export function unknownCustomerName(opts: { region?: string; plateNo?: string; phone?: string }): string {
  const regionPart = opts.region?.trim() ? `${opts.region.trim()} ` : ''
  const phone4 = phoneLast4(opts.phone ?? '')
  if (phone4) return `미상(${regionPart}📞 ${phone4})`
  const plate4 = plateLast4(opts.plateNo ?? '')
  if (plate4) return `미상(${regionPart}🚚 ${plate4})`
  return '미상'
}
