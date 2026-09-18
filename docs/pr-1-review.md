# PR #1 검토 결과

검토일: 2026-09-18 KST. 결론: **수정 필요(REQUEST CHANGES)**. 독립 코드 검토와 구조 검토를 수행했으며 구조 판정은 **BLOCK**입니다. 이는 원격 GitHub review를 게시했다는 뜻이 아닙니다.

최초 전용 서버 계획은 독립 구조 재검토에서 **CLEAR(계획의 일관성)** 판정을 받았습니다. 후속 무중단 배포 계획과 게시 범위는 [구현 명세](zero-downtime-deployment-plan.md)에 정리합니다. PR #1 소스의 결함 수정이나 운영 준비 완료를 뜻하지 않습니다.

## 검토 기준과 원격 상태

- [PR #1](https://github.com/EVNSolution/EVN-MARKETING/pull/1): OPEN, `feat/server-deployment` → `main`, head `a7bf7d0b2f7c09ddfca3807bc477beb52c201b06`, base `9e777953967c918a7b10133d7f525b4917ec945d`.
- 원격 fetch 및 PR 본문·댓글·전체 변경 목록·CI job/로그를 직접 확인했습니다. base main에는 README만 있으며 변경은 74개 파일, +16,619/-2입니다. 최초 서비스 전체가 포함되므로 배포 파일만 대상으로 삼지 않았습니다.
- 독립 코드 검토 범위: app 24, components 2, lib 5, workers 3, Prisma 6, tests 7, docs 7, scripts 2, CI 1, root/config 17 — 변경 경로 74/74개. 별도 구조 검토에서 배포·데이터·수집·복구 경계를 교차 확인했습니다.
- 원본 저장소의 작업 트리는 깨끗했으며 기존 checkout을 유지했습니다. 계획 산출물은 같은 head의 격리 worktree와 `codex/marketing-dedicated-server-plan` 브랜치에만 작성했습니다.
- 초기 검토에서는 WARP 저장소 구현/운영, AWS 리소스, DNS, IAM, 운영 비밀값, 실제 DB/업로드를 조회·변경하지 않았습니다. 후속 무중단 계획에서는 WARP 배포 소스만 읽기 전용으로 확인했습니다. 운영 전용 키나 WARP 전체 SSM 환경값을 읽지 않았습니다.
- 이 보고서의 코드 줄 번호는 **검토 head 기준**입니다. 증거 링크는 해당 head에 고정하고 파일명 옆에 줄을 표시했습니다. 수정 계획은 [전용 서버 계획](dedicated-server-plan.md)에 있습니다.

## 우선 수정 사항

### R1. [P1 / 높음] 명함 삭제가 업로드 밖의 DB 파일까지 지울 수 있습니다

근거: [고객 PUT](https://github.com/EVNSolution/EVN-MARKETING/blob/a7bf7d0b2f7c09ddfca3807bc477beb52c201b06/app/api/customers/%5Bid%5D/route.ts) 76행, [명함 처리](https://github.com/EVNSolution/EVN-MARKETING/blob/a7bf7d0b2f7c09ddfca3807bc477beb52c201b06/app/api/customers/%5Bid%5D/contact-card/route.ts) 15–20, 43–47, 63–68행, [Dockerfile](https://github.com/EVNSolution/EVN-MARKETING/blob/a7bf7d0b2f7c09ddfca3807bc477beb52c201b06/Dockerfile) 31행.

로그인한 사용자가 임의 `contactsJson`을 저장할 수 있고, 그 안의 `cardUrl`은 명함 교체/삭제 시 파일 경로로 사용됩니다. `/api/uploads/../marketing.db`는 `/data/marketing.db`로 해석됩니다. node 사용자가 `/data`를 소유하므로 DB 파일 unlink가 가능해 데이터 유실과 서비스 중단으로 이어집니다. 독립 검토자가 임시 디렉터리의 합성 sentinel로 `escaped: true`, `sentinelDeleted: true`를 재현했습니다. 실제 DB나 실서비스 HTTP 쓰기에는 접근하지 않았습니다.

수정: 경로 필드는 서버가 만든 값만 보존하고, 삭제할 실제 경로가 해당 고객의 업로드 디렉터리 안에 있는지 검사해야 합니다. `..`, 인코딩 변형, 다른 고객 경로, symlink 우회에 대한 합성 회귀 검사가 필요합니다. 새 파일 기록 → DB 참조 갱신 → 기존 파일 정리 순서로 실패 시 기존 정상 파일을 보존합니다.

### R2. [P1 / 높음] 고객 파일이 공개 캐시로 1년간 재사용될 수 있습니다

근거: [업로드 GET](https://github.com/EVNSolution/EVN-MARKETING/blob/a7bf7d0b2f7c09ddfca3807bc477beb52c201b06/app/api/uploads/%5B...path%5D/route.ts) 17–33행.

인증을 통과한 고객 문서/명함 응답에 `public, max-age=31536000, immutable`을 반환합니다. 인증 쿠키와 별개로 공유 캐시 재사용을 허용하고, 브라우저도 로그아웃·파일 삭제 후 이전 사본을 유지할 수 있습니다. 아직 실제 프록시 캐시 유출을 관측한 것은 아니지만 개인정보 응답 정책 자체가 잘못되어 있습니다.

수정: `private, no-store`와 프록시 캐시 비활성화, `nosniff` 및 적절한 다운로드 정책을 적용합니다. 비인증 접근 거부와 로그아웃/삭제 이후 재사용 방지를 함께 검증합니다.

### R3. [P1 / 높음] 운영 이미지에 WARP 점검 CLI가 없습니다

근거: [Dockerfile](https://github.com/EVNSolution/EVN-MARKETING/blob/a7bf7d0b2f7c09ddfca3807bc477beb52c201b06/Dockerfile) 15–28행, [.dockerignore](https://github.com/EVNSolution/EVN-MARKETING/blob/a7bf7d0b2f7c09ddfca3807bc477beb52c201b06/.dockerignore) 1–21행, [package.json](https://github.com/EVNSolution/EVN-MARKETING/blob/a7bf7d0b2f7c09ddfca3807bc477beb52c201b06/package.json) 19행, [container smoke](https://github.com/EVNSolution/EVN-MARKETING/blob/a7bf7d0b2f7c09ddfca3807bc477beb52c201b06/tests/container-smoke.mjs) 8–18행, [배포 문서](https://github.com/EVNSolution/EVN-MARKETING/blob/a7bf7d0b2f7c09ddfca3807bc477beb52c201b06/docs/production-deployment.md) 46–48행.

운영 절차는 check/pilot을 요구하지만 이미지에는 worker 번들만 들어갑니다. `scripts/warp-delivery.ts`와 실행기 `tsx`는 모두 빠져 있습니다. 따라서 개발 환경의 `npm run warp:delivery -- check|pilot` 명령을 그대로 운영 컨테이너에 적용할 수 없습니다.

수정: check/pilot을 독립 JS 번들로 포함하고, 개발 의존성 없이 최종 이미지 안에서 fail-closed·최초 등록·재전송·lease 정리를 합성 검증합니다. 전환 파일럿은 기존 worker를 멈춘 상태에서만 수행합니다.

### R4. [P1 / 높음] 한 번의 자동 로그인 실패가 영구 대기로 남을 수 있습니다

근거: [worker](https://github.com/EVNSolution/EVN-MARKETING/blob/a7bf7d0b2f7c09ddfca3807bc477beb52c201b06/workers/inquiry-sync.ts) 53–75행, [자동 로그인](https://github.com/EVNSolution/EVN-MARKETING/blob/a7bf7d0b2f7c09ddfca3807bc477beb52c201b06/workers/mleverage-source.ts) 62–84행.

`automaticLoginAttempted=true`를 설정한 뒤 로그인 실패 결과를 사용하지 않습니다. 페이지가 로그인 화면에 남으면 `prepareProtectedPage`가 false이고, 플래그가 다시 false가 되는 성공 분기에 도달하지 않아 동일 프로세스에서 로그인 재시도가 없습니다. headless 서버에서는 일시적 원본 장애도 운영자 재시작까지 수집 중단으로 남을 수 있습니다.

수정: 일시 오류에는 상한과 간격이 있는 재시도, 잘못된 자격증명에는 명시적 상태/경보를 제공합니다. 첫 시도 실패 후 성공, 세션 만료, 브라우저 crash와 SIGTERM 시나리오를 검증합니다.

### R5. [P1 / 배포 요구 불일치] WARP 서버 동거 전제를 제거해야 합니다

근거: [배포 문서](https://github.com/EVNSolution/EVN-MARKETING/blob/a7bf7d0b2f7c09ddfca3807bc477beb52c201b06/docs/production-deployment.md) 8–12, 31행, [README](https://github.com/EVNSolution/EVN-MARKETING/blob/a7bf7d0b2f7c09ddfca3807bc477beb52c201b06/README.md) 84행.

기존 WARP AWS 서버를 우선 대상으로 하고 용량에 따라 분리를 판단합니다. 사용자가 요구한 운영 자원·장애 영향 분리와 충돌합니다. Marketing 전용 compute·volume·ECR·배포 역할·SSM·HTTPS·백업을 기본으로 확정해야 합니다. 현재 WARP 공개 HTTPS+전용 키 호출 경계는 유지할 수 있습니다([발신기](https://github.com/EVNSolution/EVN-MARKETING/blob/a7bf7d0b2f7c09ddfca3807bc477beb52c201b06/lib/warp-delivery.ts) 5, 27–32행).

### R6. [P2 / 운영 개선] 영구 규격 오류도 매시간 재전송합니다

근거: [발신기](https://github.com/EVNSolution/EVN-MARKETING/blob/a7bf7d0b2f7c09ddfca3807bc477beb52c201b06/lib/warp-delivery.ts) 52, 91–100, 150–167행.

400/413을 `warp_invalid_inquiry`로 기록하지만 재시도 대상에서 제외하지 않습니다. 데이터가 바뀌지 않아도 매시간 같은 오류 요청을 반복합니다. 정상 15초 순회에서는 방금 실패한 행이 다음 순회에서 제외되어 뒤 행이 진행할 수 있으므로 “불량 50건이면 항상 전체 정체”로 판정하지 않습니다.

수정: 영구 규격 오류를 충돌 보류와 구분해 격리하고 운영자 재개 절차를 둡니다. 정상 후속 행 처리와 오류 폭주 상한을 검증합니다.

### R7. [P2 / 중간] 업로드 크기·형식·총량 제한이 없습니다

근거: [문서 업로드](https://github.com/EVNSolution/EVN-MARKETING/blob/a7bf7d0b2f7c09ddfca3807bc477beb52c201b06/app/api/customers/%5Bid%5D/documents/route.ts) 21–31행, [명함 업로드](https://github.com/EVNSolution/EVN-MARKETING/blob/a7bf7d0b2f7c09ddfca3807bc477beb52c201b06/app/api/customers/%5Bid%5D/contact-card/route.ts) 29–39행.

인증된 요청의 파일을 크기 확인 없이 메모리 Buffer로 만든 뒤 저장합니다. 큰 파일 또는 반복 업로드는 웹과 SQLite가 사용하는 메모리/디스크를 소진할 수 있습니다. 서버측 byte/type 검사, 프록시 body 제한, 파일/고객별 총량, 교체 파일 정리를 계획에 포함했습니다.

### R8. [P1 / 높음, API 활성화 전] 외부 리드의 모호한 고객 연결과 동시 중복 생성

근거: [리드 API](https://github.com/EVNSolution/EVN-MARKETING/blob/a7bf7d0b2f7c09ddfca3807bc477beb52c201b06/app/api/external/leads/route.ts) 51–77행, [README 계약](https://github.com/EVNSolution/EVN-MARKETING/blob/a7bf7d0b2f7c09ddfca3807bc477beb52c201b06/README.md) 67행, [Customer 모델](https://github.com/EVNSolution/EVN-MARKETING/blob/a7bf7d0b2f7c09ddfca3807bc477beb52c201b06/prisma/schema.prisma).

동일 번호에 대해 findFirst와 create가 분리되어 두 요청이 모두 “없음”을 읽을 수 있습니다. 전화번호의 DB uniqueness도 없습니다. 기존 같은 번호 고객이 여러 명이면 findFirst가 그중 한 명을 임의 선택하여 새 이력을 연결합니다. 숫자 정규화도 없어 표기 변형은 다른 고객이 될 수 있습니다. 이 문제는 Marketing의 별도 외부 리드 API이며 WARP 발신기의 UUID 중복 방지와 혼동하지 않아야 합니다. 키가 없으면 이 API는 비활성입니다.

수정: 기존 중복 데이터를 먼저 확인하는 별도 승인된 단계, 정규화 규칙, 충돌 보류/직렬화 또는 검토된 제약조건, 동시 요청 회귀 검사가 필요합니다. 이번에는 실제 고객을 병합하거나 schema를 바꾸지 않았습니다.

### R9. [P2 / 중간] 상세 화면 복귀 버튼에 임의 외부 URL을 넣을 수 있습니다

근거: [상세 페이지](https://github.com/EVNSolution/EVN-MARKETING/blob/a7bf7d0b2f7c09ddfca3807bc477beb52c201b06/app/%28app%29/customers/%5Bid%5D/page.tsx) 13, 21행, [상세 클라이언트](https://github.com/EVNSolution/EVN-MARKETING/blob/a7bf7d0b2f7c09ddfca3807bc477beb52c201b06/app/%28app%29/customers/%5Bid%5D/CustomerDetailClient.tsx) 445–453행.

query의 returnTo를 검증 없이 router.push에 전달하여 업무 화면 복귀 버튼이 외부 사이트로 이동할 수 있습니다. 현재 설치한 Next 16.3.5는 javascript:를 E978로 차단하므로 스크립트 실행 취약점으로 판정하지 않았습니다. 허용한 내부 상대 경로만 받도록 제한합니다.

### R10. [P2 / 중간] 서비스별 비밀값 범위가 넓습니다

근거: [Compose](https://github.com/EVNSolution/EVN-MARKETING/blob/a7bf7d0b2f7c09ddfca3807bc477beb52c201b06/docker-compose.yml) 6–15, 21, 28–33행.

공통 environment로 웹도 WARP 발신 키를 받고 수집기도 웹 AUTH_SECRET/외부 리드 키를 받습니다. 한 컨테이너 침해 시 불필요한 다른 역할의 비밀값까지 노출됩니다. 웹의 현재 configured UI를 비밀값 없는 상태로 바꾼 뒤 서비스별 최소 환경변수로 나눕니다.

### R11. [P2 / 중간] 파일 metadata 오류와 교체 실패가 정상 처리처럼 숨겨집니다

근거: [명함 처리](https://github.com/EVNSolution/EVN-MARKETING/blob/a7bf7d0b2f7c09ddfca3807bc477beb52c201b06/app/api/customers/%5Bid%5D/contact-card/route.ts) 10–20행, [문서 처리](https://github.com/EVNSolution/EVN-MARKETING/blob/a7bf7d0b2f7c09ddfca3807bc477beb52c201b06/app/api/customers/%5Bid%5D/documents/route.ts) 10–12, 33, 65–69행.

JSON 파싱 실패를 빈 배열로 대체하여 다음 저장 시 기존 metadata를 잃을 수 있고, unlink 실패를 무시한 채 참조를 삭제합니다. 같은 문서 유형 교체는 기존 파일을 정리하지 않아 참조 없는 개인정보 파일이 남습니다. 손상된 metadata는 비노출 오류로 중단·보존하고 검증된 교체/삭제 순서 및 orphan 파일 점검을 추가합니다.

## 운영 준비의 누락과 유지할 설계

- **운영 미구현:** PR CI는 build/smoke만 하며 image push/release/deploy가 없습니다. Compose는 local image/build와 project별 자동 volume을 허용합니다([Compose](https://github.com/EVNSolution/EVN-MARKETING/blob/a7bf7d0b2f7c09ddfca3807bc477beb52c201b06/docker-compose.yml) 1–3, 35–36행). digest 강제·고정 영속 volume·전용 release·readiness·복원 도구는 후속 구현 대상입니다. 준비 PR에 없는 운영 기능을 이미 완료된 것으로 표시하지 않습니다.
- **백업:** SQLite와 파일 metadata 갱신은 원자적이지 않습니다. 모든 writer를 멈추고 backup API·업로드 manifest·참조 검사를 사용해야 합니다. 완료된 백업이 새 볼륨에서 복구되는지 증거가 필요합니다.
- **단일 실행:** 동일 DB의 lease/fencing은 구현되어 있지만 복사된 로컬/서버 DB 사이에서는 작동하지 않습니다. 기존 Mac 프로세스·자동 실행을 중지하고 최신 receipt를 보존한 뒤 서버를 하나만 켜야 합니다.
- **복구 한계:** WARP 활동/고객 삭제 시 수신 중복 기록도 사라지는 계약입니다. 어느 한쪽을 오래된 백업으로 복원하는 경우 현재 delivered 필드만으로 양쪽 일치를 증명할 수 없습니다. 자동 재전송 대신 운영자 대조가 필요합니다.
- **유지할 장점:** 전용 키+활성화 스위치, 10초 timeout/redirect 거부, 결정적 activity ID와 receipt 검증, 409 충돌 보류, WAL+busy timeout, 비루트 실행, seed·실DB·비밀값 이미지 제외, collector 수동 profile은 적절합니다.
- **기존 역할 정책:** 모든 고객 API가 admin 전용이어야 한다는 요구는 확인되지 않았습니다. role 검사 부재만으로 임의 권한 변경을 지시하지 않습니다.
- **문서 정확성:** `CLAUDE.md`에는 Git/lockfile/CI/migrations/test가 없다는 이전 설명이 남아 있습니다. 현재 실제 파일과 충돌하므로 수정 계획에 포함했습니다.
- **문서 정확성(낮음):** `docs/inquiry-sync-runtime.md:55`, `docs/inquiry-sync-plan.md:102`의 서버 자격증명 미구현 설명도 현재 Linux 환경변수 구현과 맞지 않습니다. 전용 서버 절차와 함께 정리합니다.

## 검증 결과와 한계

| 구분 | 이번 확인 | 의미/한계 |
| --- | --- | --- |
| 원격 Linux CI | [run 35194264731](https://github.com/EVNSolution/EVN-MARKETING/actions/runs/35194264731), head a7bf7d0, verify SUCCESS | 수집/DB/발신/계약/타입, 이미지 build, 비루트 Chromium, 네트워크 차단 worker 실패 시 lease 해제, 로그인 페이지 응답. 운영 로그인/배포 증거 아님 |
| 로컬 새 재검사 | macOS 격리 worktree, Node 22.23.2, npm ci 및 Prisma generate | 실제 .env/DB를 가져오지 않음 |
| 합성 검사 | test:server-runtime, test:db, test:inquiries, test:warp-delivery, test:integration-contract 전부 통과 | DB 테스트는 WAL·reader/writer·rollback·3,000 commits·재오픈 무결성 포함; 실제 별도 Linux 두 프로세스 부하/원본 사이트 로그인은 미검증 |
| 타입/정적 검사 | typecheck 통과, lint 오류 0/경고 4 | 경고는 CustomerDetailClient useEffect 1, img 3. PR CI에는 lint step 없음 |
| npm audit | 전체 high 5 / critical 0 | Prisma CLI 관련 4 + 개발 lint 경로 js-yaml 1. CI는 주요 CLI 경로 제외를 검사하지만 이미지 OS/전체 런타임 무결점 증거 아님 |
| 이번 실행하지 않은 검사 | Docker 이미지 재빌드, 실제 서버/HTTPS 브라우저 로그인, 운영 원본 자동 로그인, 고객 자료 이관, 최초/재전송 실API, 시간당 실행·재부팅·백업 복원·RAM 실측 | 기존 Linux CI 로그를 직접 읽었으며 실제 운영 확인으로 승격하지 않음 |

기록된 문의 409 / 등록 406 / 충돌 보류 3은 개발자의 과거 기록입니다. 현재 DB를 직접 검증한 집계로 표시하지 않습니다. 애플리케이션 코드/배포 설정은 수정하지 않았습니다. 이 검토 기록과 후속 계획을 문서 PR로 공유하며, 실제 결함 수정과 운영 검증은 별도 작업입니다.
