# evn-marketing

사내 문의 수집·WARP 고객관리 연동 서비스입니다. mleverage-admin의 신규 문의를 수집 완료 후 60분 간격으로 가져오고 회사 WARP 고객관리에 전달합니다.

**10월 1일 첫 버전**은 로그인, 문의 조회·검색, 신규 문의 자동/수동 수집, WARP 자동 등록과 상태 확인까지 제공합니다. [발표 범위·배포 완료 기준](docs/mvp-release.md)을 따릅니다. 서버 배포 완료를 뜻하지 않습니다.

## 포함된 기능

- 대시보드(외부): 원본 홈페이지의 방문·페이지뷰, 매체별 일별 유입, 네트워크와 키워드 전체 목록
- 원본 문의 조회·검색, 신규 문의 수집, WARP 등록 완료·대기·오류 표시
- 이메일·비밀번호 로그인과 JWT 세션

아래 기존 CRM 경로와 데이터는 보존하지만 첫 버전 메뉴에서는 WARP 고객관리로 연결합니다.

- 고객 목록, B2C/B2B 필터, 이름·연락처·회사명·차량번호 검색, 표시 컬럼 설정
- B2C 개인·차량·화주 정보와 B2B 법인·담당자·보유 차량·매출 정보 관리
- 담당자 지정, 소개인 표시, 영업 활동 이력 관리
- 고객 문서, 차량 사진, 담당자 명함의 로컬 파일 업로드
- 공유 API 키로 보호되는 외부 상담 신청 리드 수신 API

## 로컬 실행

Node.js와 npm이 필요합니다.

```bash
npm ci
cp .env.example .env
npx prisma generate
npm run dev
```

`.env`의 placeholder를 로컬 개발 값으로 교체합니다.

- `DATABASE_URL`: 기본 로컬 SQLite 파일 위치
- `AUTH_SECRET`: 32자 이상의 개발용 비밀값
- `AUTH_TRUST_HOST`, `AUTH_URL`, `NEXTAUTH_URL`: 로컬 인증 URL 설정
- `UPLOADS_DIR`: 업로드 파일을 저장할 쓰기 가능한 절대 경로
- `LEADS_INTAKE_API_KEY`: 외부 리드 요청의 `x-api-key`와 비교할 공유키. 비어 있으면 요청을 모두 거부합니다.

기존 로컬 CRM을 실행할 때는 현재 데이터가 있는 `dev.db`에 `prisma db push`나 seed를 실행하지 마세요. 새 빈 개발 DB를 별도로 준비하는 경우에만 다음 명령으로 스키마와 개발 계정을 만들 수 있습니다.

```bash
npx prisma db push
npm run seed
```

seed 계정의 비밀번호는 개발 전용으로 코드에 고정되어 있습니다. 운영 배포 전에는 이 계정과 비밀번호 처리 방식을 반드시 교체해야 합니다. 로그인 정보는 시스템 관리자에게 확인하세요.

앱은 기본적으로 [http://127.0.0.1:3000](http://127.0.0.1:3000)에서 열립니다.

## 검증 명령

```bash
npm run typecheck
npm run lint
```

`npm run test:inquiries`, `npm run test:warp-delivery`, `npm run test:integration-contract`로 합성 데이터 기반 수집·전송·계약 검사를 실행합니다.

## 대시보드(외부)

`/external-dashboard`와 `GET /api/external-dashboard`는 로그인한 사용자만 조회할 수 있습니다. 기존 문의 수집기의 로그인 세션·단일 소유권·수집 일정을 재사용하며, 문의 수집이 끝난 뒤 같은 브라우저의 새 탭에서 원본 대시보드의 정상 GET 응답 두 개를 관찰합니다. 저장된 성공 데이터가 없고 다음 문의 수집 시각이 아직 미래라면, worker 활성화·인증 준비 후 최초 한 번만 대시보드를 읽습니다. 초기 읽기는 문의 작업을 만들거나 기존 예정 시각을 바꾸지 않습니다. 화면 새로고침은 저장 결과만 읽고 수집 작업이나 CRM 등록을 실행하지 않습니다.

원본 계약은 `https://app.mleverage-admin.co.kr/maus/api/homepages/<기존 INQUIRY_HOMEPAGE_ID>/dashboard/overview` 및 `acquisition`이며 둘 다 쿼리가 없습니다. `result.success=true`인 두 응답의 `body`가 모두 검증된 경우만 한 번에 반영합니다. overview의 `aggregationDates`와 `monthlyViews`, acquisition의 `monthlyAdViews`, `monthlyInflows`, `monthlyKeywords`를 전부 보존합니다. 실제 날짜와 무관한 테스트 값은 합성 데이터로만 만듭니다.

방문자 합계는 원본의 집계 날짜에 속한 일별 합계입니다. 각 유입 목록 비율의 분모는 해당 목록 전체이며 원본처럼 소수점 한 자리의 나머지를 배분합니다. 매체별 차트는 원본의 지원 매체 매핑과 0인 계열 숨김을 따르고, Bing·기타를 포함한 원본 행 전체는 별도 표에서 조회할 수 있습니다. 원본에서 숨긴 `today*` 값으로 새 지표를 만들거나 임의 날짜 필터를 추가하지 않습니다.

결과는 영구 `UPLOADS_DIR/_reports/external-dashboard/current.json`에 저장합니다. 기존 worker lease와 DB 쓰기 잠금 안에서 임시 파일 fsync → 원자적 rename으로 게시하며, 기존 비공개 업로드 정책이 이 경로의 직접 다운로드를 차단합니다. 기존 오프라인 백업·복구의 uploads 전체 목록에 포함되고 스키마 변경은 없습니다. 수집 실패는 마지막 성공 데이터·시각을 보존하고 오류와 시도 시각만 갱신합니다. 첫 수집 전은 ‘—’, 검증된 실제 0은 ‘0’이며, 마지막 성공 후 2시간이 지나면 오래된 데이터임을 표시합니다.

`npm run test:external-dashboard`는 합성 원본·보존·소유권·비공개 저장을 검증합니다. worker 회귀 검사와 기존 브라우저 smoke에도 연결되어 있습니다. `npm run check:external-dashboard`는 기존 환경 또는 Mac Keychain 로그인으로 원본을 읽고 집계만 출력하는 수동 점검입니다. DB 쓰기, 문의 상태 변경, CRM 전송은 하지 않습니다. 실행 환경에 이미 있는 자격증명을 사용하며 파일이나 출력으로 복사하지 않습니다.

## 외부 리드 수신 API

`POST /api/external/leads`는 로그인 세션 대신 `x-api-key` 헤더를 사용합니다. 요청 본문은 JSON입니다.

| 필드 | 형식 | 필수 | 저장 방식 |
| --- | --- | --- | --- |
| `name` | 문자열 | 예 | 고객명 |
| `phone` | 문자열 | 예 | 연락처이자 기존 고객 판별 기준 |
| `channel` | 문자열 | 아니요 | 유입 경로 |
| `campaign` | 문자열 | 아니요 | 고객 메모 또는 재접수 활동 내용 |
| `landingUrl` | 문자열 | 아니요 | 고객 메모 또는 재접수 활동 내용 |
| `submittedAt` | 날짜 문자열 | 아니요 | 수집일 또는 활동일. 없으면 수신 시각 사용 |

현재 구현은 새 전화번호이면 B2C 잠재고객을 만들고 `201`과 `{ "ok": true, "customerId": "...", "created": true }`를 반환하며, 일치하는 고객을 찾으면 재접수 활동을 추가합니다. 다만 정규화·동시 요청·기존 복수 고객 충돌 처리가 아직 보완되지 않았으므로 **운영에서는 `LEADS_INTAKE_API_KEY`를 비워 이 API를 비활성으로 유지합니다**. 이 제한은 별도로 검증된 WARP 문의 발신 기능과 구분합니다.

- API 키 누락·불일치: `401`
- 올바르지 않은 JSON 또는 필수값 누락: `400`

## 현재 상태

2026-09-17 전용 키 인증, 원본 문의 한 건의 등록·동일 UUID 재전송, 실제 WARP 고객·문의 이력 확인을 완료하고 로컬 자동 등록을 활성화했습니다. 동일 연락처의 기존 고객이 여러 명이면 임의 선택하지 않고 보류합니다. 실행 프로세스에만 키를 주입했으므로 앱과 수집기를 종료하거나 Mac을 재시작하면 키를 다시 안전하게 주입해야 합니다. 최신 검증 집계와 제한은 아래 WARP 연동 안내를 확인하세요.

[실행 안내](docs/inquiry-sync-runtime.md) · [검증 기록](docs/inquiry-sync-verification.md) · [WARP 연동 안내](docs/warp-integration.md)

## 서버 컨테이너 준비

격리된 검증 환경에서는 `MARKETING_REVISION`에 소스 SHA를 지정한 뒤 `docker compose up -d --build web`로 웹만 127.0.0.1:3100에 바인딩할 수 있습니다. 운영에서는 서버에서 빌드하지 않고 승인된 경로에서 만든 이미지 digest를 `MARKETING_IMAGE`로 주입해 `--no-build`로 실행합니다. 인증 비밀값과 공개 `AUTH_URL` 등은 실행 환경에서 주입하며 Compose용 `.env` 파일에 비밀값을 저장하지 마세요. 데이터베이스 URL은 `file:/data/marketing.db`, 업로드 경로는 `/data/uploads`입니다. 기존 SQLite 파일 전체(사용자, 문의, WARP 전송 기록 포함)와 업로드 파일을 같은 영구 볼륨에 이관한 후 실행해야 합니다. 컨테이너 시작 시 migration이나 seed는 실행하지 않습니다.

기존 Mac 수집기를 중지하고 데이터 이관을 확인한 뒤에만 `MLEVERAGE_USERNAME`과 `MLEVERAGE_PASSWORD`를 실행 환경에 함께 주입하고, 그 실행 위치에서 `INQUIRY_COLLECTOR_ENABLED=true`를 지정해 `docker compose --profile collector up -d worker`로 서버 수집기를 켜세요. 새 운영 worker 컨테이너마다 고유 UUID v4인 `MARKETING_WORKER_OWNER`도 주입해야 합니다. 이 값은 비밀값이 아니며 worker와 그 컨테이너의 상태 점검이 함께 사용합니다. 누락·형식 오류 시 DB를 열기 전에 종료합니다. 명시적 활성화가 없으면 수집기는 DB·브라우저·자격증명에 접근하기 전에 종료합니다. 서버에서는 Chromium이 기본적으로 headless입니다. `INQUIRY_BROWSER_HEADLESS`는 `true` 또는 `false`만 지정할 수 있습니다. WARP 전송은 기본적으로 꺼져 있으며, 승인된 점검 후 `WARP_DELIVERY_ENABLED=true`로 활성화합니다.

`docker compose exec worker node worker-health.mjs`로 실행 소유권·최근 heartbeat·원본 준비 상태를 읽기 전용으로 확인합니다. 정상은 JSON `ok:true`/종료 코드 0, 비정상은 `ok:false`/종료 코드 1입니다. release SHA/digest도 설정해야 하며 세부 조건과 한계는 [worker 상태 확인](docs/production-deployment.md#수집기-상태-확인과-프로세스-경쟁-검사)을 참고하세요.

현재 이 구성은 운영 배포 완료를 의미하지 않습니다. 배포 대상은 **WARP와 자원을 공유하지 않는 Marketing 전용 신규 서버**입니다. [배포 계획 안내](docs/production-deployment.md), [전용 서버·자료 이관 계획](docs/dedicated-server-plan.md), [WARP 방식 무중단 배포 명세](docs/zero-downtime-deployment-plan.md), [PR #1 검토 결과](docs/pr-1-review.md)를 확인하세요. 일반 배포는 웹 blue/green과 수집기 단일 인계를 목표로 하며, 현재 Compose에 이 절차가 구현되었다는 뜻은 아닙니다.

구버전 화면과 두 웹 서버의 업로드 검사는 [웹 호환성 안내](docs/web-compatibility.md)에 정리합니다. Docker 직접 빌드에도 `--build-arg MARKETING_BUILD_REVISION=<소스 SHA>`가 필요합니다.

## 원격 브랜치 관리

`main`을 정본으로 두고 목적별 단기 브랜치·PR로 작업합니다. PR이 merge 또는 close되면 열린 PR 참조와 고유 commit을 확인한 뒤 해당 원격 head를 정리합니다. 자세한 규칙은 [AGENTS.md](AGENTS.md)를 참고하세요.
