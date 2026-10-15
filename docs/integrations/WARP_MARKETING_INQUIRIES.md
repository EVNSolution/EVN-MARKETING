# 마케팅 문의 수신 연동 검토

## 2026-10-15 기존 고객 이름 보완 — 검토 대상

신규 또는 과거 같은 번호 문의에 실명이 있고 WARP에는 이름 미상 고객이 있는 경우, 별도 `POST /api/external/marketing-inquiries/customer-name`에서 **미리보기 → 사용자 확인 → 이름 보완**을 수행한다. 새 고객·리드를 등록하거나 기존 리드의 이름을 수정하는 기능이 아니다. 과거 문의, 등록 영수증, 등록완료 상태와 유입 집계는 보존한다.

- 전용 `WARP_MARKETING_API_KEY`로 새 제한 권한 `customer.unknown-name.enrich`만 추가한다. BUILDUP 키·일반 고객 수정 권한은 사용하지 않는다. 기존 append는 고객 정보를 덮어쓰지 않고, check는 기존 응답 형식을 그대로 유지한다.
- 정확한 두 출처 튜플과 원본 문의 UUID를 요구한다. Marketing 서버가 보관 중인 동일 번호 문의에서 실명을 선택하고, 인증된 관리자 세션에서 요청자 ID·이름을 정한다. 웹에는 키를 추가하지 않으며 기존 lease 소유 worker가 보호된 단기 작업을 처리한다. 서명된 미리보기 토큰은 서버에서만 보관하고 브라우저에 전달하지 않는다.
- 입력은 action/source/companyScopeId/homepageScopeId/sourceId/phone/name/actor의 정확한 필드만 허용한다. confirm에는 previewToken이 추가로 필수이고 preview에는 허용하지 않는다. actor는 id/name만 받는다. 본문 16KB, 이름 100자, 요청자 ID 128자, 요청자 이름 100자, 휴대폰 40자, 토큰 2,048자 한도이며 제어문자나 이름·요청자의 앞뒤 공백은 거부한다.
- 유효한 국내 휴대폰 기본 연락처로만 비교한다(+82/0082·기존 011/016/017/018/019 포함). 회사 번호·보조 연락처·리드 단독 번호는 이름 수정 대상을 찾는 근거가 아니다. 일치 고객이 없으면 not_found, 여러 명이면 ambiguous로 보류하며 후보 고객 정보는 반환하지 않는다.
- 유일한 현재 고객이 공란·하이픈·정확한 미상/신원미상 형식(괄호 부연 가능)이거나 이름 자체가 같은 휴대폰일 때만 ready다. 실제 이름이 이미 있으면 already_named, 제안 이름과 같으면 same_name이며 수정 토큰을 발급하지 않는다. 실제 이름에 ‘미상’이라는 글자가 포함됐다는 이유로 덮어쓰지 않는다.
- preview는 읽기 전용이며 유일한 고객의 id/name/정규화된 요청 phone과 proposedName만 노출한다. ready인 경우 전용 키 HMAC으로 출처·원본 문의·전화·실명·요청자·고객 ID·기존 이름/수정시각·10분 만료를 묶은 토큰을 발급한다.
- confirm은 customerWrite의 공통 쓰기 잠금에서 고객 유일성, 통합되지 않은 동일 고객 ID, 이름/updatedAt 일치와 미상 여부를 다시 확인한다. 다른 담당자가 수정했거나 고객이 통합·삭제되었으면 409 stale_preview로 새 미리보기를 요구한다. 토큰 위변조·만료는 400 invalid_preview이며 고객 정보는 바뀌지 않는다.
- 성공 시 Customer.name과 자동 updatedAt만 바꾸고 CustomerActivity에 변경 전후 이름, 정확한 출처와 원본 문의 ID, 요청자, 시각을 같은 트랜잭션으로 남긴다. 감사 저장 실패 시 이름 변경도 취소된다. 감사 ID는 미리보기 토큰에서 결정하며 기존 문의 등록 활동 ID와 구분한다.
- 같은 확인 요청의 재전송은 토큰 유효기간 내 보관된 감사와 현재 고객 이름/updatedAt/휴대폰/정체성이 일치할 때만 unchanged로 응답한다. 정상 최초 저장은 updated다. 감사 삭제·변경이나 이후 고객 변경은 성공 재전송으로 간주하지 않는다. 기존 CustomerActivity의 보존 기간과 편집 권한을 사용하는 변경 이력이며 별도 불변 감사 저장소를 신설하지 않는다.

기계 판독 계약과 응답·오류 목록은 JSON의 customer_name_enrichment에 있다. Marketing은 사용자 확인을 받아 이 경로만 실행하고, 이름 보완 성공을 신규 등록완료 또는 새 DB 유입으로 집계하지 않는다. 운영 공개 전에 양쪽 PR 링크를 JSON에 채우고 파일을 동일하게 맞춘다. 검토 범위는 [기존 Issue #48](https://github.com/EVNSolution/EVN-WARP/issues/48)과 [CRM 위임](https://github.com/EVNSolution/EVN-WARP/pull/56#issuecomment-6009236448)이며 배포 순서는 WARP → Marketing이다. 실제 고객 수정·리드 생성·일괄 보정 없이 합성 DB로 검증한다. 스키마·IAM·배포 경로 변경은 없다.

## 2026-10-08 홈페이지 수동 CRM 등록 확장 — 검토 대상

이번 변경은 기존 전용 키와 두 외부 경로를 재사용한다. 기존 mleverage 계약과 활동 ID는 유지하고, 홈페이지의 정확한 출처 evn-landing / evnsolution / pv5를 별도로 허용한다. 홈페이지는 HH:mm:ss, 기존 수집 문의는 종전 HH:mm 형식을 유지한다. 홈페이지 고객의 source는 evn-landing이며 활동 제목·상담 종류·지역·동의 버전/시각을 원본대로 보관한다. 새 테이블이나 열은 없다.

홈페이지 요청은 rejectExistingCustomer: true와 제한된 landing 메타데이터가 필수다. 활동 ID는 evn_landing_와 정확한 출처 튜플/원본 UUID 해시이며, 기존 mleverage_ ID는 바뀌지 않는다. 같은 UUID를 두 출처에서 사용해도 영수증은 섞이지 않는다. WARP의 고객 쓰기 트랜잭션이 최종 동일 번호 경쟁을 차단한다.

Marketing에서는 출처 전체의 정규화 번호가 겹치는 미전송 문의를 모두 중복검토로 보류한다. 홈페이지는 자동 설정과 무관하게 매번 명시적인 수동 등록 요청이 필요하다. 실패·중단 후 자동 재전송하지 않으며, 영수증만 복구된 경우 등록완료가 아닌 등록 확인 필요로 남긴다. 기존 수집 문의의 자동 설정/파일 기반 복구 선택 범위는 유지한다.

상담 종료는 대기 중 등록을 취소하고, 전송 중에는 409로 보류한다. 완료 후 종료는 Marketing의 개인정보만 삭제하며 WARP 고객·활동은 삭제하지 않는다. 중단된 전송은 worker lease 기간 이후 결과 확인 필요로 전환되며 새 수동 요청으로 기존 영수증부터 확인한다.

배포 순서는 **WARP 수신기 → Marketing 발신기**다. 두 PR은 [기존 계약 Issue #48](https://github.com/EVNSolution/EVN-WARP/issues/48)과 [위임 범위](https://github.com/EVNSolution/EVN-WARP/pull/56#issuecomment-6009236448)에 따라 검토한다. 기존 자동 전송 설정은 바꾸지 않고 과거 문의 일괄 전송·운영 고객 생성으로 검증하지 않는다. 미지원 수신기/조회 실패/불완전 응답은 등록 성공으로 처리하지 않는다.

아래는 이전 계약 및 활성화 작업의 기록이다. 현재 확장 범위는 위 설명과 JSON 계약을 따른다.


2026-09-17 · 운영 담당자: OziinG · 상태: Owner 소스 검토, 발신측 활성화 대기

기계 판독 계약은 [WARP_MARKETING_INQUIRIES.json](WARP_MARKETING_INQUIRIES.json)이다. 이 변경은 기존 WARP–BUILDUP 계약과 공유키 권한을 수정하지 않는다. [검토 Issue #48](https://github.com/EVNSolution/EVN-WARP/issues/48)과 [검토 PR #49](https://github.com/EVNSolution/EVN-WARP/pull/49)에 연결한다. 2026-09-17 Owner 검토에서 UUID 대소문자 중복 및 독립 DB 연결의 잠금 경합을 재현해 수정하고 회귀 검사를 추가했다. 최종 승인·배포 Revision과 결과는 PR에 기록한다. 발신측 저장소는 이번 검토 환경에 없으므로 활성화 전에 수정된 계약의 일치와 발신측 검증을 확인해야 한다.

## 변경 결과

`POST /api/external/marketing-inquiries`는 전용 `WARP_MARKETING_API_KEY`로 고정된 mleverage-admin 회사·홈페이지 문의만 받는다. 키는 32자 이상·공백 없음이어야 하며, 비어 있으면 503으로 비활성화한다. 요청은 16KB까지만 읽는다.

기본 연락처를 숫자로 정규화한 완전일치 고객이 한 명이면 문의 이력만 추가한다. 기존 이름·상태·담당자·메모는 바꾸지 않는다. 일치 고객이 없으면 성함·연락처를 입력한 B2C 잠재고객을 만들며 빈 이름을 허용한다. 이름이 같고 연락처가 다르면 별도 고객이다. 같은 연락처의 고객이 여러 명이면 409로 보류한다.

활동 ID는 `mleverage_` 접두사와 출처·회사·홈페이지·소문자로 정규화한 원본 UUID의 SHA-256이다. 고객 생성과 활동 추가를 같은 트랜잭션에서 처리하고, 활동이 보존된 동안의 재전송은 기존 receipt를 돌려준다. 새로운 DB 테이블·열은 없고 기존 Customer/CustomerActivity를 사용한다. 조회 전에 행을 변경하지 않는 UPDATE로 SQLite 쓰기 잠금을 확보해 독립 연결의 read-to-write 잠금 교착을 막는다. 해당 트랜잭션 연결의 busy timeout은 0으로 두고 기존 비동기 재시도를 사용한다. 동일 문의·같은 연락처의 별도 문의 병렬 전송과 경합 이후 쓰기를 합성 SQLite로 검증한다.

활동 내용에는 원본 문의일자·문의시간·상담상태·성함·연락처와 문의 ID를 읽을 수 있는 문장으로 저장한다. 원본 날짜·시간은 분 단위 문자열로 보존하고 CRM 날짜는 한국 시간으로 해석한다. 원본 화면에 시간대 표기가 없으므로 한국 시간 해석은 확인이 필요한 가정이다.

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


## 고객·잠재리드 통합 등록 — 2026-10-13 확장

앞으로 실행되는 공통 등록 흐름은 기존 POST와 read-only check에 `registrationPolicy: "customer-lead-v1"`을 명시한다. 이전 발신기는 정책을 생략하므로 기존 고객·문의 이력 계약을 유지한다. 구 수신기는 추가 필드를 거부하므로 WARP 수신기를 먼저 배포한다.

- 적용 경로: 홈페이지 문의 및 mleverage 문의의 동일 등록 버튼 → 공통 worker → 기존 marketing-inquiries API. 기존 완료 문의·수동 완료 기록은 변경하지 않는다. 운영 복구/pilot은 기존 고객 이력용이며 새 정책 확인이나 과거 리드 생성에 사용하지 않는다.
- 운영에서 읽기 전용으로 확인한 매핑은 담당자 이름 최도준, Product.code=STEGO K1, Product.name=PV5 오픈배드냉탑 (구변)이다. 수신기가 정확히 일치하는 활성 제품 ID 한 개와 담당자 이름 한 개를 확인한다. 없는 값·중복 이름·비활성 제품은 `lead_mapping_unavailable`로 쓰기 전에 보류한다. User에는 활성 플래그가 없다.
- 신규 Customer.source와 SalesDeal.source는 온라인이다. 신규 리드는 실제 Product ID 및 최도준을 연결한다. 메모는 최초 성공 등록 시점의 한국 날짜 + ` SNS 유입`이다. 원본 문의 시각은 기존 collectedAt/문의 이력에 유지한다.
- Customer, CustomerActivity, SalesDeal, B2C 미성숙리드(1-1) 체크 전체, 최초 생성과 1-2 전환 이력을 같은 customerWrite 트랜잭션에 저장한다. 현재 1-1 항목은 배송업 의향 확인(1-1-0)이며 1-2 체크는 설정하지 않는다. 마지막 이력 저장이 실패해도 고객까지 모두 취소된다.
- 리드 ID는 `lead_ + activityId`로 고정한다. 신규 활동의 result에 정책 마커를 보관하고 createdAt을 등록 시각으로 보존한다. 재전송/동시 요청/응답 유실은 보관된 동일 고객·리드·등록 시각을 반환하며 영업 담당자나 후속 메모·단계를 덮어쓰지 않는다.
- v1 응답의 registration은 policy/state/leadId/registeredAt을 포함한다. 정책 마커와 연결 리드가 확인돼야 complete다. 과거 고객 전용 이력이나 삭제/연결 해제된 리드는 customer_only로 돌려주고 소급 생성하지 않는다. Marketing은 고객 ID/활동 ID만 보관하고 완료 시각을 기록하지 않으며 ‘고객 등록 확인 · 리드 미완료’로 검토 보류한다.
- 신규 실패는 중복 확인부터 안전하게 재시도한다. 홈페이지 문의의 수동 재요청 정책과 기존 자동 등록 설정은 유지한다. 연락처가 이미 존재하면 고객과 리드 모두 생성하지 않는다.

스키마 변경·마이그레이션·과거 데이터 보정은 없다. 배포 담당자는 WARP PR → Marketing PR 순서로 검토/배포하고 정확한 버전과 검사 결과를 남긴다. 전용 키 범위/SSM 권한/배포 경로는 그대로 유지한다. 검토 근거는 Issue #48 및 PR #56의 CRM 위임이며 이번 PR 링크는 계약 JSON에 기록한다.

추가 중복 조건: customer-lead-v1은 Customer가 연결되지 않은 기존 SalesDeal도 정규화 휴대폰으로 확인한다. 읽기 전용 check와 동일 writer 트랜잭션의 저장 직전 검사에서 모두 보류하며, 기존 리드 병합이나 갱신은 하지 않는다.
