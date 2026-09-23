# 마케팅 문의 수신 연동 검토

2026-09-17 · 운영 담당자: OziinG · 상태: 신규 이름 규칙의 후속 Owner 검토 대기

기계 판독 계약은 [WARP_MARKETING_INQUIRIES.json](WARP_MARKETING_INQUIRIES.json)이다. 이 변경은 기존 WARP–BUILDUP 계약과 공유키 권한을 수정하지 않는다. [Issue #48](https://github.com/EVNSolution/EVN-WARP/issues/48)과 [PR #49](https://github.com/EVNSolution/EVN-WARP/pull/49)는 빈 이름을 그대로 두던 이전 계약의 검토 이력이다. 이번 신규 고객 표시 이름 규칙은 후속 Owner 검토가 필요하다. 2026-09-17 기존 Owner 검토에서는 UUID 대소문자 중복 및 독립 DB 연결의 잠금 경합을 재현해 수정했다. 최종 승인·배포 Revision과 결과는 [후속 PR #50](https://github.com/EVNSolution/EVN-WARP/pull/50)에 기록한다.

## 변경 결과

`POST /api/external/marketing-inquiries`는 전용 `WARP_MARKETING_API_KEY`로 고정된 mleverage-admin 회사·홈페이지 문의만 받는다. 키는 32자 이상·공백 없음이어야 하며, 비어 있으면 503으로 비활성화한다. 요청은 16KB까지만 읽는다.

기본 연락처를 숫자로 정규화한 완전일치 고객이 한 명이면 문의 이력만 추가한다. 기존 이름·상태·담당자·메모는 바꾸지 않는다. 일치 고객이 없으면 B2C 잠재고객을 만들고, 원본 성함을 다듬은 값이 비어 있을 때 WARP의 `unknownCustomerName({ phone })`으로 표시 이름을 생성한다(예: `미상(📞 8888)`). 이름이 같고 연락처가 다르면 별도 고객이다. 같은 연락처의 고객이 여러 명이면 409로 보류한다.

활동 ID는 `mleverage_` 접두사와 출처·회사·홈페이지·소문자로 정규화한 원본 UUID의 SHA-256이다. 고객 생성과 활동 추가를 같은 트랜잭션에서 처리하고, 활동이 보존된 동안의 재전송은 기존 receipt를 돌려준다. 새로운 DB 테이블·열은 없고 기존 Customer/CustomerActivity를 사용한다. 조회 전에 행을 변경하지 않는 UPDATE로 SQLite 쓰기 잠금을 확보해 독립 연결의 read-to-write 잠금 교착을 막는다. 해당 트랜잭션 연결의 busy timeout은 0으로 두고 기존 비동기 재시도를 사용한다. 동일 문의·같은 연락처의 별도 문의 병렬 전송과 경합 이후 쓰기를 합성 SQLite로 검증한다.

활동 내용에는 원본 문의일자·문의시간·상담상태·성함·연락처와 문의 ID를 읽을 수 있는 문장으로 저장한다. 원본 성함이 빈 문자열이나 공백이어도 생성된 표시 이름으로 대체하지 않는다. 원본 날짜·시간은 분 단위 문자열로 보존하고 CRM 날짜는 한국 시간으로 해석한다. 원본 화면에 시간대 표기가 없으므로 한국 시간 해석은 확인이 필요한 가정이다.

## 로컬 검증

- `npm run test:marketing-inquiries`: UUID 대소문자 재전송, 독립 연결 경합/후속 쓰기, append 실패의 rollback과 비밀정보 없는 오류 로그를 포함한 합성 시나리오 12개.
- `npm run test:integration-contract`: 기존 6개와 신규 1개, 총 7개 계약 통과.
- 타입 검사, 수정 파일 ESLint, 로컬 프로덕션 빌드 통과. 빌드의 DB 주소는 합성 로컬 경로를 사용했다.
- 마케팅 sender와 실제 receiver 함수를 연결한 합성 DB 검사 통과: 이름 공란, 같은 연락처로 문의 이력 추가, 응답 재처리 중복 방지.
- PR 검증과 운영 배포의 소스 검사에 문의 수신 테스트를 추가했다. 배포 워크플로 계약 검사 8개와 기존 정책에 따른 보안 검사를 통과했다.
- 운영 DB·실제 문의 등록·키 설정·배포는 수행하지 않았다.

## 운영 인계

WARP 수신기는 IP 허용목록 없이 공용 HTTPS에서 접근할 수 있고 전용 키를 요구한다. 로컬 발신기는 Wi-Fi의 동적 공인 IP로 테스트할 수 있으며 고정 IP나 EIP가 필요하지 않다. 키가 없거나 형식이 잘못되면 503 `not_configured`로 닫히고 잘못된 요청 키는 401을 받는다. AGENTS.md의 Owner-reviewed Issue/PR 요구에 따라 검토 후 정규 release 절차로 main을 반영한다. 전용 키는 운영 담당자의 승인된 비밀 관리 경로에서 설정하고 앱은 SSM `/evn-warp/app-env`를 읽기만 한다. 기존 BUILDUP 키를 재사용하거나 배포 중 SSM 값 쓰기·로컬 .env 대체·운영 DB 직접 수입으로 우회하지 않는다. 담당자에게 키를 전달할 때 GitHub 댓글·문서·채팅에 값을 넣지 않는다.

마케팅은 이미 보관한 문의도 미전달 대상으로 보낸다. 키 설정 전에는 전송하지 않는다. 운영 반영 후 같은 키를 마케팅 프로세스에 안전하게 주입하고, 초기 전달 결과를 확인한 뒤 전체 미전달 문의를 처리한다. 완료·대기·오류 건수와 실제 CRM 이력을 확인해야 운영 연동 완료로 볼 수 있다. 로그·문서에는 고객 자료나 키를 남기지 않는다.

기본 연락처 스캔은 초기 최소 구현이다. CRM 규모에서 지연이 확인되면 정규화 열과 인덱스를 검토한다. 사용자가 WARP 고객이나 수신 활동을 명시적으로 삭제하면 중복 방지 기록도 삭제되므로 이후 재전송은 고객 또는 활동을 다시 만들 수 있다. 삭제 이후까지의 영구 중복 방지는 제공하지 않으며 임의 재전송·DB 복구는 별도 결정이 필요하다.

## 로컬 발신 담당자 연결 안내

- 주소: `POST https://warp.cleversystem.ai/api/external/marketing-inquiries`
- 인증: `x-api-key` 헤더에 운영 담당자가 별도 보안 경로로 전달한 전용 키를 넣는다. 기존 BUILDUP 키는 사용하지 않는다.
- 네트워크: 인터넷 연결과 HTTPS(443)만 필요하다. Wi-Fi 공인 IP의 사전 등록, 고정 IP, EIP, VPN은 필요하지 않다. DB·SSH 포트를 개방하는 방식이 아니다.
- 키는 로컬 서버/worker의 비밀 환경변수로만 주입하고 브라우저 번들, 저장소, 로그, GitHub 댓글에 넣지 않는다.

실제 데이터를 등록하기 전에 발신기 환경의 `WARP_MARKETING_API_KEY`를 사용해 아래 명령으로 인증·접근만 확인할 수 있다. 빈 payload를 의도적으로 보내므로 CRM에 쓰지 않으며 **HTTP 400 / bad_payload가 성공 기준**이다. 응답이 401이면 키를, 503 `not_configured`이면 WARP 키 설정을 확인한다.

```sh
node --input-type=module <<'JS'
const key = process.env.WARP_MARKETING_API_KEY
if (!key) throw new Error('WARP_MARKETING_API_KEY is required')
const response = await fetch('https://warp.cleversystem.ai/api/external/marketing-inquiries', {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-api-key': key },
  body: '{}',
  signal: AbortSignal.timeout(10000),
})
const body = await response.json()
if (response.status !== 400 || body.error !== 'bad_payload') {
  throw new Error(`Connection check failed: HTTP ${response.status}`)
}
console.log('Authentication and public HTTPS access passed; no CRM records written')
JS
```

다음 단계에서는 계약의 9개 필드에 맞는 실제 원본 문의 한 건을 발신기에서 전송한다. 첫 응답은 200과 `created: true`, 같은 `sourceId`의 재전송은 200과 `duplicate: true`여야 한다. CRM의 고객 및 문의 이력을 확인한 후 미전달 문의 처리를 시작한다. 409 `ambiguous_phone`은 자동 재시도하지 말고 담당자가 중복 연락처를 확인한다. 503 `temporarily_unavailable`은 같은 `sourceId`를 유지한 채 지연 재시도한다. 서버 로그에는 `marketing_inquiry_failed`와 허용된 오류 코드·재시도 여부만 남는다.
