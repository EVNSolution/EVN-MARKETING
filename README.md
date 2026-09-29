# evn-marketing

사내 문의 수집·WARP 고객관리 연동 서비스입니다. mleverage-admin의 신규 문의를 수집 완료 후 60분 간격으로 가져오고 회사 WARP 고객관리에 전달합니다.

**10월 1일 첫 버전**은 로그인, 문의 조회·검색, 신규 문의 자동/수동 수집, WARP 자동 등록과 상태 확인까지 제공합니다. [발표 범위·배포 완료 기준](docs/mvp-release.md)을 따릅니다. 서버 배포 완료를 뜻하지 않습니다.

## 포함된 기능

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
