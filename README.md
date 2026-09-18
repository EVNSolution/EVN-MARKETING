# evn-marketing

WARP에서 분리한 사내용 고객 관계 관리(CRM) 애플리케이션입니다. mleverage-admin 문의를 1시간마다 신규 건만 수집하고, 회사 WARP 고객관리에 전달하는 로컬 개발 서비스입니다.

## 포함된 기능

- 원본 문의 조회·검색, 신규 문의 수집, WARP 등록 완료·대기·오류 표시
- 이메일·비밀번호 로그인과 JWT 세션
- 고객 목록, B2C/B2B 필터, 이름·연락처·회사명·차량번호 검색, 표시 컬럼 설정
- B2C 개인·차량·화주 정보와 B2B 법인·담당자·보유 차량·매출 정보 관리
- 담당자 지정, 소개인 표시, 영업 활동 이력 관리
- 고객 문서, 차량 사진, 담당자 명함의 로컬 파일 업로드
- 공유 API 키로 보호되는 외부 상담 신청 리드 수신 API

## 로컬 실행

Node.js와 npm이 필요합니다.

```bash
npm install
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

새 전화번호이면 B2C 잠재고객을 만들고 `201`과 `{ "ok": true, "customerId": "...", "created": true }`를 반환합니다. 같은 전화번호가 이미 있으면 고객을 중복 생성하지 않고 재접수 활동을 추가한 뒤 `200`과 `created: false`를 반환합니다.

- API 키 누락·불일치: `401`
- 올바르지 않은 JSON 또는 필수값 누락: `400`

## 현재 상태

2026-09-17 전용 키 인증, 원본 문의 한 건의 등록·동일 UUID 재전송, 실제 WARP 고객·문의 이력 확인을 완료하고 로컬 자동 등록을 활성화했습니다. 동일 연락처의 기존 고객이 여러 명이면 임의 선택하지 않고 보류합니다. 실행 프로세스에만 키를 주입했으므로 앱과 수집기를 종료하거나 Mac을 재시작하면 키를 다시 안전하게 주입해야 합니다. 최신 검증 집계와 제한은 아래 WARP 연동 안내를 확인하세요.

[실행 안내](docs/inquiry-sync-runtime.md) · [검증 기록](docs/inquiry-sync-verification.md) · [WARP 연동 안내](docs/warp-integration.md)

## 서버 컨테이너 준비

격리된 검증 환경에서는 `docker compose up -d --build web`로 웹만 127.0.0.1:3100에 바인딩할 수 있습니다. 운영에서는 서버에서 빌드하지 않고 승인된 경로에서 만든 이미지 digest를 `MARKETING_IMAGE`로 주입해 `--no-build`로 실행합니다. 인증 비밀값과 공개 `AUTH_URL` 등은 실행 환경에서 주입하며 Compose용 `.env` 파일에 비밀값을 저장하지 마세요. 데이터베이스 URL은 `file:/data/marketing.db`, 업로드 경로는 `/data/uploads`입니다. 기존 SQLite 파일 전체(사용자, 문의, WARP 전송 기록 포함)와 업로드 파일을 같은 영구 볼륨에 이관한 후 실행해야 합니다. 컨테이너 시작 시 migration이나 seed는 실행하지 않습니다.

기존 Mac 수집기를 중지하고 데이터 이관을 확인한 뒤에만 `MLEVERAGE_USERNAME`과 `MLEVERAGE_PASSWORD`를 실행 환경에 함께 주입하고 `docker compose --profile collector up -d worker`로 서버 수집기를 켜세요. 서버에서는 Chromium이 기본적으로 headless입니다. `INQUIRY_BROWSER_HEADLESS`는 `true` 또는 `false`만 지정할 수 있습니다. WARP 전송은 기본적으로 꺼져 있으며, 승인된 점검 후 `WARP_DELIVERY_ENABLED=true`로 활성화합니다.

현재 이 구성은 운영 배포 완료를 의미하지 않습니다. 배포 대상은 **WARP와 자원을 공유하지 않는 Marketing 전용 신규 서버**입니다. [배포 계획 안내](docs/production-deployment.md), [전용 서버·자료 이관 계획](docs/dedicated-server-plan.md), [WARP 방식 무중단 배포 명세](docs/zero-downtime-deployment-plan.md), [PR #1 검토 결과](docs/pr-1-review.md)를 확인하세요. 일반 배포는 웹 blue/green과 수집기 단일 인계를 목표로 하며, 현재 Compose에 이 절차가 구현되었다는 뜻은 아닙니다.
