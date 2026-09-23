# WARP 방식의 Marketing 무중단 배포 구현 명세

작성: 2026-09-18 KST. 상태: **계획 PR / 미구현·미배포**. 선행 검토는 [PR #1 검토서](pr-1-review.md), 인프라·이관·비용은 [전용 서버 계획](dedicated-server-plan.md)을 따릅니다.

## 1. 범위와 성공의 의미

Marketing 전용 서버에서 **일반 애플리케이션 릴리스 중 웹 요청을 유지**하는 blue/green 방식을 구현합니다. old/new 웹을 동시에 준비하고, 준비된 후보로 프록시를 바꾼 후 직전 버전을 롤백 대상으로 보관합니다. 수집기는 DB/외부 전송의 단일 소유자여야 하므로 순서대로 인계합니다.

| 상황 | 목표·처리 |
| --- | --- |
| 동일/상호 호환 schema의 일반 앱 릴리스 | 로그인·조회·저장·업로드 요청을 계속 처리하고 배포가 원인인 HTTP 실패·연결 단절·성공 응답 데이터 유실 0건 |
| worker 교체 | 잠깐의 처리 지연을 허용하되 동시 owner 1개, 수집/전송 이력 보존, 다음 시간당 실행 복구. 웹 무중단과 별도 계측 |
| 최초 Mac → 신규 서버 이관 | 최종 일관된 snapshot을 위한 쓰기 중지가 필요. 사전 고지된 전환 작업으로 분리 |
| 파괴적/비호환 schema 변경, 비밀값 rotation, 일관된 전체 파일 백업 | 일반 무중단 경로로 실행하지 않음. 별도 검토된 유지보수 작업 또는 선행 호환 변경 필요 |
| 호스트/AZ 장애, 무기한 방치한 구버전 탭 | 단일 서버만으로 무중단 보장하지 않음. 각각 재해 복구와 명시된 버전 유지창 정책 적용 |

성공 판정은 실제 전환 부하·브라우저 증거로 합니다. Nginx reload 성공이나 `/login` 200만으로 무중단을 선언하지 않습니다.

## 2. 직접 확인한 WARP 참조

조회 시 WARP `main`은 `de373dab5f3ee23924e4032b8be440a07839bd10`입니다. 아래는 **소스 구현 확인**이며 이번에 WARP 운영 서버를 호출하거나 상태를 검증한 기록이 아닙니다.

| 확인한 구현 | 고정 소스 근거 | Marketing 반영 |
| --- | --- | --- |
| main/SHA 확인, 직렬 release, 테스트, ECR SHA 이미지/digest, 이미지 검사 | [workflow 20–24, 47–62, 90–199행](https://github.com/EVNSolution/EVN-WARP/blob/de373dab5f3ee23924e4032b8be440a07839bd10/.github/workflows/deploy-ec2-ssm.yml#L20-L199) | Marketing 전용 workflow/OIDC/ECR, `cancel-in-progress: false`, 정확한 SHA/digest 검증 |
| 배포 스크립트·migration 묶음을 한정된 SSM 명령으로 전달 | [workflow 230–289행](https://github.com/EVNSolution/EVN-WARP/blob/de373dab5f3ee23924e4032b8be440a07839bd10/.github/workflows/deploy-ec2-ssm.yml#L230-L289) | 전용 호스트만 대상으로 실행; 운영 secret 값을 command/output에 넣지 않음 |
| inactive slot 준비 → 로컬 readiness → Nginx 전환 → 외부 readiness → 실패 복귀 | [remote-deploy 134–310행](https://github.com/EVNSolution/EVN-WARP/blob/de373dab5f3ee23924e4032b8be440a07839bd10/deploy/remote-deploy.sh#L134-L310) | 동일 단계의 Marketing 전용 state machine |
| candidate revision 재확인, previous-slot 수동 rollback | [remote-deploy 336–355행](https://github.com/EVNSolution/EVN-WARP/blob/de373dab5f3ee23924e4032b8be440a07839bd10/deploy/remote-deploy.sh#L336-L355) | 직전 정상 웹·worker digest를 보존하고 DB는 최신 그대로 유지 |
| DB/필수 테이블/쓰기 경로와 deployment identity readiness | [readyz 15–38행](https://github.com/EVNSolution/EVN-WARP/blob/de373dab5f3ee23924e4032b8be440a07839bd10/app/api/readyz/route.ts#L15-L38) | 후보의 schema/volume 접근, revision/digest, 외부 프록시 경로를 각각 확인 |
| migration checksum ledger·backup·exclusive transaction·preflight | [migration 147–223행](https://github.com/EVNSolution/EVN-WARP/blob/de373dab5f3ee23924e4032b8be440a07839bd10/deploy/apply-schema-migrations.py#L147-L223) | 무비판적으로 복사하지 않음. SQLite exclusive lock 영향을 별도 검증하고 호환 schema만 일반 배포 허용 |
| 30분 관측, 승인 SQL만 적용, seed/db push 금지; 최초 bootstrap 중단 별도 표기 | [RUNBOOK 49–80행](https://github.com/EVNSolution/EVN-WARP/blob/de373dab5f3ee23924e4032b8be440a07839bd10/deploy/RUNBOOK.md#L49-L80), [setup 54–76행](https://github.com/EVNSolution/EVN-WARP/blob/de373dab5f3ee23924e4032b8be440a07839bd10/deploy/setup-ec2.sh#L54-L76) | 관측창과 bootstrap/일반 release 분리 |

WARP 소스에서 별도의 in-flight drain/구버전 종료 프로토콜은 확인되지 않았습니다. 아래의 호스트 잠금, Next 버전별 요청 라우팅, 명시적 drain, worker 인계 journal은 **Marketing에 추가할 설계**입니다. WARP의 코드·키·SSM 경로·배포 역할을 복사하거나 변경하지 않습니다.

세부 차이도 구분합니다. WARP는 candidate upstream 파일을 만들고 기존 설정을 백업한 뒤 `cp`로 교체하여 `nginx -t → reload → 외부 readiness`를 검사하고 실패하면 백업을 `cp`로 복구합니다([165–209행](https://github.com/EVNSolution/EVN-WARP/blob/de373dab5f3ee23924e4032b8be440a07839bd10/deploy/remote-deploy.sh#L165-L209)). atomic rename과 호스트 `flock`은 확인되지 않았습니다. Server Actions 키는 SSM→BuildKit secret→빌드 환경변수로 전달합니다([workflow 121–153행](https://github.com/EVNSolution/EVN-WARP/blob/de373dab5f3ee23924e4032b8be440a07839bd10/.github/workflows/deploy-ec2-ssm.yml#L121-L153), [Dockerfile 7–19행](https://github.com/EVNSolution/EVN-WARP/blob/de373dab5f3ee23924e4032b8be440a07839bd10/Dockerfile#L7-L19)). 이번에는 해당 **코드만 읽었고 값은 읽지 않았습니다**.

## 3. 운영 산출물과 불변조건

| 산출물(후속 구현 경로안) | 책임 |
| --- | --- |
| `.github/workflows/release.yml` | main의 검증된 SHA → amd64 이미지 → ECR 검사 → digest → production environment → 한정 SSM 실행. 배포/rollback job에 공통 concurrency 적용 |
| `deploy/compose.production.yml` | `web-blue`(127.0.0.1:3100), `web-green`(127.0.0.1:3101), worker. build/local fallback 없음, digest 필수, external volume 고정 |
| `deploy/remote-deploy.sh`, `deploy/rollback.sh` | 한 호스트 lock 아래 preflight/prepare/switch/verify/rollback; 모든 입력 검증, 재실행 가능 단계, secret 없는 journal |
| `deploy/nginx/` | 기본 active upstream + 허용된 deployment ID 매핑 + TLS/인증 헤더/비공개 업로드 정책. 임시 설정 검사 후 전환 |
| `app/api/readyz/route.ts`, `deploy/worker-health.*` | DB/schema·volume identity·revision/digest와 worker owner/heartbeat/오류 상태를 구분 |
| `deploy/backup.*`, `deploy/restore.*`, migration target | 일관된 전체 snapshot, 복원본 검증, 별도 승인 migration. 웹/worker 이미지에 Prisma CLI를 넣지 않음 |
| `tests/deploy/`, 운영 runbook | 전환 부하/기존 탭/장애 주입/worker 경쟁/복구 증거와 운영 체크리스트 |

호스트 경로안은 `/opt/evn-marketing-runtime/{releases,state,nginx}`이고 data는 별도 영속 볼륨입니다. `state`에는 `activeWeb`, `previousWeb`, `activeWorker`, SHA/digest, `phase`, `deploymentId`, schema 호환 범위, 시각만 저장합니다. 파일은 임시 파일→flush→rename으로 저장하고 복구 시 컨테이너·프록시·DB lease와 대조합니다. marker 하나만 믿고 성공 처리하지 않습니다.

- 정상 종료 상태의 웹과 worker는 같은 release digest입니다. **전환 중** old/new 웹과 old/new worker 버전이 잠시 다를 수 있으므로 N/N-1 호환성 검사가 선행되어야 합니다.
- 웹 두 슬롯은 동일 DB/업로드를 사용합니다. 후보 프로세스에 collector나 스케줄러를 자동 실행하지 않습니다. candidate health는 business 데이터에 쓰지 않습니다.
- 같은 volume에 대한 웹 두 프로세스+worker 동시 접근을 실제 Linux 프로세스로 검증합니다. WAL/5초 busy timeout 설정만으로 다중 프로세스 안정성을 증명했다고 하지 않습니다.
- candidate는 별도 포트로 직접 검사하며 다른 서비스/WARP 프록시 파일을 수정하지 않습니다. 공통 Docker daemon도 신규 Marketing 호스트의 것만 사용합니다.
- readiness의 주입된 SHA/digest 문자열과 실제 실행 이미지 증거를 구분합니다. 호스트에서 컨테이너 Image ID/RepoDigest를 승인 digest와 대조하고, 응답 identity·프록시 도착 슬롯과 함께 기록합니다.
- 배포·rollback·backup·migration은 동일 호스트 `flock`을 공유하고 CI concurrency만으로 동시 SSM 실행을 막았다고 가정하지 않습니다. lock 취득 실패는 변경 없이 종료합니다. 관리자가 취소한 workflow의 SSM 실행은 별도로 종료/상태 확인합니다.

## 4. 일반 배포 상태 전이

```text
LOCKED → PREFLIGHT_OK → CANDIDATE_READY → OLD_WORKER_STOPPED
       → PROXY_SWITCHED → NEW_WORKER_HEALTHY → VERIFIED → COMMITTED
실패: 전환 전 후보 정리 / 전환 후 직전 정상 slot·worker 복귀
불명확: 자동 다음 배포 차단 → 실제 상태 대조 후 복구
```

1. **Preflight:** main SHA와 승인된 digest, 아키텍처, 이미지 검사, current/previous identity, 외부 HTTPS, schema 호환, 최근 24시간 이내의 일관된 오프호스트 백업 및 복원 검증 이력을 확인합니다. 일반 release 때문에 active 웹을 멈춰 새 backup을 만들지 않습니다. 백업 조건 미충족이면 배포 전에 중단합니다.
2. **용량 확인:** active+candidate 웹, Chromium worker 한 개, 프록시/OS, 두 이미지와 rollback/staging 공간이 동시에 들어가는지 검사합니다. 실패 시 active 유지. 기존 웹을 먼저 내려 공간을 만드는 우회는 금지합니다.
3. **Candidate:** 검토된 digest로 inactive 웹을 시작합니다. approved schema를 읽고 local readiness 3회 연속, direct HTTP·인증 거부·필수 정적 자산을 확인합니다. 공개 도메인 Host/Proto를 반영한 세션 검사는 합성 환경에서 먼저 마칩니다. 이 시점까지 기존 웹/worker는 계속 운영합니다.
4. **Worker drain:** 기존 worker에 stop 의도를 전달해 새 작업/전송 claim을 멈추고 진행 중 요청의 결과·receipt·run 상태를 기록합니다. 최대 drain 시간은 180초를 초기 제안으로 두고 실측합니다. 정상 종료/lease 해제와 프로세스 부재를 모두 확인한 뒤에만 다음 worker를 허용합니다. timeout이면 일반 배포를 중단하여 old worker를 회복하고, 강제 종료는 별도 복구 경로에서 수행합니다.
5. **Proxy switch:** candidate와 직전 슬롯용 버전 라우팅을 포함한 설정을 임시 파일로 만들고 검사합니다. 이전 설정을 보존한 뒤 atomic replace→`nginx -t`→graceful reload합니다. public 기본 `/api/readyz`가 기대 SHA/digest를 3회 연속 반환하고 인증/업로드 경계가 유지되는지 확인합니다. 실패하면 즉시 이전 프록시 설정으로 복귀합니다.
6. **New worker:** 같은 승인된 digest로 worker 하나만 시작합니다. lease owner와 heartbeat, 원본 로그인 상태를 확인합니다. 기존 `nextRunAt`/pending 상태를 보존하고 일괄 재수집·즉시 백로그 전송을 부작용으로 일으키지 않습니다. 새 worker 준비 실패 시 웹·worker 조합을 함께 이전 버전으로 복귀합니다.
7. **검증/관측:** 공개 HTTP 1초 간격 probe와 합성 환경의 실제 브라우저 동작을 전환 전부터 30분 관측창 종료까지 수집합니다. 운영에서는 승인된 계정의 비파괴 확인과 기존 실제 요청의 집계만 사용합니다. 처리 지연·5xx·DB lock·OOM·worker 재시작 증가가 기준을 벗어나면 실패로 판정합니다.
8. **Commit/drain:** 외부 검증과 worker health 성공 후 release journal을 commit합니다. 구버전 웹은 최소 30분 호환 창과 rollback 대상으로 유지합니다. 프록시의 구버전 요청이 끝난 것을 확인한 뒤 slot 재사용을 허용하고, 해당 슬롯 정지 시 SIGTERM과 최소 30초 drain을 줍니다. 진행 요청이 남으면 slot을 재사용하지 않습니다. 다음 배포는 이전 관측/호환 창을 완료한 후 시작합니다.

worker 교체 지연 목표는 180초 이내이며 실제 측정으로 확정합니다. 주기 의미는 현재 코드의 “성공/실패 run 완료 + 60분”입니다. 일반 배포가 예약을 재설정하거나 두 worker를 동시에 보내지 않도록 시작·중지 코드를 수정합니다. 매 배포에 의도치 않게 수집 즉시 실행/자동 전송이 재개되는 것도 회귀 검사 대상입니다.

## 5. Next.js 클라이언트와 세션 연속성

Marketing은 Next 16.3.5 standalone이고 로그인/로그아웃에 Server Actions를 사용합니다. 포트 전환만 하면 열린 탭의 이전 JS chunk, prefetched RSC, action ID가 새 서버와 어긋날 수 있습니다. [공식 self-hosting 안내](https://nextjs.org/docs/app/guides/self-hosting), [deploymentId 동작](https://nextjs.org/docs/app/api-reference/config/next-config-js/deploymentId)를 기준으로 아래를 구현합니다.

- 이미지 한 번을 빌드하고 같은 digest를 사용하며 release SHA를 `deploymentId`로 고정합니다. 같은 deployment의 여러 인스턴스는 동일 빌드/action key를 공유합니다. `AUTH_SECRET`, cookie 이름/도메인/secure 설정은 일반 배포에서 바꾸지 않습니다.
- `?dpl=`은 Next 자체의 라우팅 기능이 아닙니다. 프록시에서 현재/직전의 **등록된 ID만** 실제 슬롯으로 매핑합니다. JS/CSS는 `dpl`, hydrated RSC/Server Actions는 `x-deployment-id`를 사용합니다. 임의 값을 upstream 주소/파일 경로로 연결하지 않습니다. ID는 인증 권한이 아닙니다.
- JS 미로드·비활성 상태의 progressive form POST는 `x-deployment-id`를 보장하지 않습니다. 로그인/로그아웃 form의 실제 POST 대상 URL에도 렌더링한 release ID를 고정하여 탭별로 식별해야 합니다. 인증 쿠키와 별도의 release 라우팅 쿠키는 문서 응답에 설정하되 **보조 수단**으로만 사용합니다. 쿠키는 등록 ID·고정 만료만 허용하고, 새 탭이 쿠키를 바꿔도 이전 form의 명시적 ID를 덮어쓰지 못하게 합니다. 명시적 URL/header ID를 우선하며 이 둘의 충돌, 만료 또는 버전 판별 불가 시 action을 실행하지 않고 갱신을 안내합니다. 실제 Next SSR form의 제출 URL/인코딩을 보존하는 구현 가능성과 여러 탭의 no-JS 제출을 M2에서 먼저 검증하며, cookie만 추가한 상태로 이 gate를 통과시키지 않습니다.
- 일반 문서 요청은 active로 가고, 유효한 이전 버전의 asset/action 요청은 보존 중인 이전 슬롯으로 갑니다. public `/api/readyz`는 cookie·버전 header/query와 무관하게 active 슬롯만 검사합니다. REST 요청은 N/N-1 요청·응답 호환성을 유지합니다. slot 재사용 전에 해당 이전 ID 매핑을 안전하게 만료시킵니다.
- 다른 release 간 action 암호키를 같게 하는 것만으로 action ID 호환성이 해결되지는 않습니다. 첫 구현은 각 빌드의 키와 action을 해당 버전 슬롯으로 라우팅합니다. 장기 공통 `NEXT_SERVER_ACTIONS_ENCRYPTION_KEY`가 필요해지면 별도 검토합니다. 이 키는 빌드 산출물에 내장되므로 “런타임에만 주입하면 된다”거나 “이미지에 없다”고 설명하지 않습니다. WARP 키를 재사용하지 않습니다.
- 30분 이전 버전 유지창 이후의 오래된 탭은 강제 새로고침·쓰기 자동 재시도 대신 버전 만료를 인식하고 갱신을 안내합니다. 미저장 고객 입력을 자동으로 버리지 않도록 클라이언트가 처리해야 하며 개인정보를 임의 localStorage에 저장하지 않습니다. 이때 지원 범위를 넘는 오래된 action은 성공으로 표시하지 않습니다.
- 배포 직전 열어둔 고객 상세 저장, 파일 업로드, 로그인/로그아웃, 페이지 이동을 전환 뒤 수행해 chunk 404, action 오류, 세션 해제, 요청 재실행 및 입력 손실이 없는지 확인합니다. 이 검사 없이 UX 무중단을 선언하지 않습니다.

## 6. schema·백업·rollback 규칙

- 기본 무중단 경로는 schema 변경이 없거나 **미리 적용·검증된** additive expand schema만 허용합니다. old/new 웹과 worker 모두 같은 현재 schema를 읽고 써야 합니다. 컬럼 삭제/이름 변경/의미 변경, backfill, 장시간 index 생성은 일반 배포에서 금지합니다.
- expand migration도 SQLite write lock 때문에 요청 지연/실패를 일으킬 수 있습니다. 복원본의 동시 부하에서 lock 시간·busy timeout·HTTP 결과를 측정한 별도 단계로 적용합니다. 통과하지 못하면 유지보수 작업으로 분리합니다. contract migration은 구버전 rollback/탭 유지창을 종료한 다음 별도 release로 진행합니다.
- 일반 릴리스는 최신 DB에 코드만 되돌립니다. 배포 직전 백업으로 DB를 자동 복원하면 전환 이후 고객 수정·문의·WARP receipt를 잃을 수 있어 금지합니다. 전체 복원은 단일 writer 위치와 최신 전송 이력을 대조하는 별도 재해 복구입니다.
- 전환 전 실패는 후보만 제거하며 active 웹/worker를 유지합니다. old worker가 이미 멈췄다면 old worker를 하나만 재시작합니다. 전환 후 실패는 새 worker 정지→프로세스 부재/lease 확인→이전 proxy 설정과 old 웹 준비 확인→old worker 하나 시작→public digest 및 lease 재검증 순서입니다.
- 이전 웹/worker가 현재 schema와 호환되지 않거나 journal과 실제 실행 상태가 다르면 자동 rollback하지 않습니다. 추가 writer 시작을 막고 현재 상태를 보존한 뒤 명시된 유지보수 복구로 전환합니다. 이를 정상 완료로 처리하지 않습니다.
- deployment lock은 backup/migration과 공유합니다. 일관된 전체 DB+uploads 백업은 별도 writer 정지 창에서 수행하고 일반 release 관측 중 끼어들지 않습니다. 복원 가능한 최근 백업이 없으면 release를 거부합니다.

## 7. 필수 인수 검사

아래는 전체 운영 인수 기준입니다. 계획 작성 시에는 모두 미실행이었으며, 후속 PR의 부분 검증은 [웹 호환성](web-compatibility.md), [DB 호환성과 복구](data-compatibility.md), [운영 준비 기록](production-deployment.md)에 구분합니다. 일부 합성 검사 통과를 Z01–Z10 전체 또는 운영 완료로 표시하지 않습니다. CI 합성 환경은 WARP/원본 서비스로 나가는 네트워크를 차단합니다.

| ID | 시나리오 | 합격 증거 |
| --- | --- | --- |
| Z01 | 정상 A→B, B→A 전환 중 1초 probe+동시 조회/저장/업로드 | 배포 원인 HTTP/연결 오류 0, 성공 응답을 받은 데이터 모두 존재, 기대 digest 전환 |
| Z02 | 배포 전 열린 탭의 로그인/로그아웃·상세 저장·업로드·lazy chunk·RSC; JS 미로드/비활성 form POST와 신·구 여러 탭의 cookie 변경 | 호환 창 안에서 세션 유지, native/hydrated action 모두 올바른 버전 도착, chunk/action 오류 0, 재전송/입력 손실 0; readyz는 항상 active |
| Z03 | 후보 crash/OOM, schema/volume 오류, readiness 실패 | 프록시 미전환, old 웹/worker 유지, 후보 정리 |
| Z04 | nginx 설정 오류/reload 실패/전환 후 외부 probe 실패 | 이전 설정 복구, old digest 확인, DB 복원 없음 |
| Z05 | 새 worker 로그인/health 실패, remote commit 후 ack 전 강제 종료 | old 또는 new 한 owner만 동작, 같은 activityId 중복 응답으로 회복, receipt 보존 |
| Z06 | 두 release/rollback/backup 동시 시작, SSM timeout/연결 끊김 | lock 경쟁자는 무변경 종료, 실제 journal·proxy·container·lease 대조 후 안전 재개 |
| Z07 | old/new 웹+worker SQLite 병렬 쓰기·읽기, 두 worker 동시 claim | 처리 실패 0, worker owner 1, 무결성/receipt 일치. 단일 프로세스 테스트로 대체 불가 |
| Z08 | 30분 호환 창 경계, slot 재사용, 종료 중 장기 요청 | 만료 ID가 다른 버전으로 잘못 라우팅되지 않음, 입력 자동 폐기/쓰기 자동 재시도 없음, in-flight drain 증거 |
| Z09 | 호스트 재부팅·불완전 journal·worker lease 만료 | 정해진 active digest/volume만 복구, 임의 후보 자동 승격 없음, worker 1개 |
| Z10 | 최신 데이터 유지한 코드 rollback, 양방향 DB 복원 시점 불일치 | 일반 rollback의 데이터 보존, 재해 복구의 승인 대상·receipt 대조·복원 시간 기록 |

산출물은 `source SHA`, runtime/ops digest, CI URL, SSM command ID(값/로그에 secret 없음), 전환 전후 active/previous 상태, 백업 summary ID, probe 결과 집계, 익명화한 브라우저 검증, worker owner 수·실행 시각을 묶습니다. 원본 고객 내용·쿠키·비밀번호·API 키는 증거에 포함하지 않습니다.

## 8. 구현 PR 순서와 검토 책임

M3 구현의 현재 계약과 부분 검증 범위는 [배포·복귀 컨트롤러](release-controller.md), AWS 실행 경계는 [AWS 배포 연결](cloud-release.md)에 기록합니다. 구현은 Python 표준 라이브러리와 Docker CLI를 사용하여 아래 계획의 Compose 계층을 대체합니다. 초기 설치·실제 AWS 실행·전체 Z01–Z09 통과를 의미하지 않습니다.

| 단계 | 범위 | 완료 조건·다음 단계 gate |
| --- | --- | --- |
| M1 보안/수집 선행 수정 | 검토서 P1, 업로드 수명주기/캐시, 자동로그인 복구, collector opt-in | 관련 회귀+타입/lint 통과; 실제 서비스 공개 전 필수 |
| M2 패키징/관측/호환성 | 운영 CLI, readyz, worker drain/health, deploymentId/구버전 라우팅 계약, schema 호환 검사 | 최종 이미지 합성 smoke와 Z02/Z05/Z07 통과 |
| M3 독립 release/rollback | ECR/SSM/OIDC 선언, 두 슬롯/프록시/호스트 lock/journal, backup gate | 합성 Linux 호스트에서 Z01/Z03/Z04/Z06/Z08/Z09 통과 |
| M4 이관/복구 리허설 | backup/restore/migration ops 및 양방향 receipt 복구 | 실데이터 없이 전체 이관·복원 및 Z10, 두 웹+Chromium peak 측정 통과 |
| M5 운영 전환 | 승인된 신규 리소스 준비→최종 자료 이관→HTTPS→파일럿→시간당/재부팅/무중단 검증 | 전용 서버 계획의 완료 기준과 실제 evidence 충족 |

PR #1 작성자 **@SUMZ711**에게 구현 계획·수집기/앱 호환성 검토를 요청합니다. 기존 PR의 운영 검토 요청 대상 **@OziinG**는 인프라·운영 전환 검토 대상으로 기록합니다. 이는 이번 문서 작성으로 담당자의 배포 승인이나 비용 승인이 확정됐다는 뜻이 아닙니다.

현재 계획 PR의 완료 조건은 문서의 상호 일관성, 고정 source 근거, 실행 순서/실패 분기/인수 기준, 원격 PR과 담당자 멘션까지입니다. M1–M5 구현·서버 생성·DNS/IAM/비밀값 변경·실데이터 이전·머지·배포는 이 PR에서 수행하지 않습니다.
