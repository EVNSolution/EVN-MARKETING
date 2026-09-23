# 문의 동기화 로컬 실행

## 실제 DB 통합 기록

기존 `dev.db`에는 마이그레이션 이력 테이블이 없고 기존 네 테이블과 로그인 사용자가 이미 있다. 첫 마이그레이션은 그 기존 구조의 기준선이며, 기존 DB에는 SQL을 다시 실행하지 않고 적용 완료로만 기록해야 한다. 그 다음 문의 동기화 마이그레이션만 배포한다.

2026-09-15에 기존 스키마가 기준선과 일치하는지 확인하고 비공개 백업을 만든 뒤, 아래 순서로 실제 `dev.db` 통합을 완료했다.

```sh
DATABASE_URL='file:./dev.db' npx prisma migrate resolve --applied 20260915000100_baseline
DATABASE_URL='file:./dev.db' npx prisma migrate deploy
```

두 번째 마이그레이션은 `Inquiry`, `InquirySyncRun`, `InquirySyncState`만 추가하며 기존 `User`, `Team`, `Customer`, `CustomerActivity`의 행이나 열을 바꾸지 않는다.

적용 후 백업과 비교해 기존 `User`, `Team`, `Customer`, `CustomerActivity` 행이 바이트 단위로 동일함을 확인했다. 이후 같은 DB에서 기준선 resolve나 추가 마이그레이션을 다시 수동 실행할 필요는 없다.

## 로컬 DB 동시 접근

로컬 앱과 수집기는 공식 `@prisma/adapter-better-sqlite3`로 동일한 SQLite 파일을 사용한다. 연결이 만들어질 때 WAL 설정을 먼저 완료하고, 잠금 대기 시간은 연결 옵션으로 5초를 유지한다. 초기화 실패는 숨기지 않는다. 기존 날짜 저장 형식은 ISO 8601로 유지하며 문의나 사용자 자료를 재작성하는 마이그레이션은 없다.

WAL 모드에서는 최신 내용이 `dev.db-wal`에 있을 수 있으므로 실행 중인 DB를 백업할 때 `dev.db`만 복사하지 말고 SQLite 백업 기능을 사용한다. DB와 WAL/SHM 파일은 이미 Git 제외 대상이다. `npm run test:db`는 합성 DB에서 열린 읽기와 수집기 쓰기, 날짜 호환, 잠금 대기 설정, 롤백 및 반복 트랜잭션을 확인한다.

## 합성 데이터 화면 확인

아래 명령은 `/tmp` 아래의 새 파일만 허용하고, 파일이 이미 있으면 중단한다. 비밀번호는 합성 화면 확인용 값을 직접 정하며 출력하지 않는다.

```sh
PREVIEW_DATABASE_URL='file:/tmp/evn-inquiry-preview.db' \
PREVIEW_ADMIN_PASSWORD='choose-a-synthetic-admin-password' \
PREVIEW_USER_PASSWORD='choose-a-synthetic-user-password' \
npm run preview:inquiries

DATABASE_URL='file:/tmp/evn-inquiry-preview.db' \
AUTH_SECRET='choose-a-synthetic-preview-secret' \
AUTH_URL='http://127.0.0.1:3100' \
NEXTAUTH_URL='http://127.0.0.1:3100' \
npm run dev -- --hostname 127.0.0.1 --port 3100
```

기본 포트가 아닌 포트를 쓰면 `AUTH_URL`과 `NEXTAUTH_URL`을 실제 접속 주소와 동일하게 지정한다.

합성 계정 이메일은 `preview-admin@example.invalid`, `preview-user@example.invalid`다. 문의 43건에는 이름 없음, 상태 미선택, 같은 형식의 합성 연락처가 포함된다.

## 수집 worker

```sh
INQUIRY_COLLECTOR_ENABLED=true npm run worker:inquiries
```

worker는 명시적으로 `INQUIRY_COLLECTOR_ENABLED=true`인 실행 위치에서만 DB·브라우저·원본 자격증명 조회를 시작한다. 기본값은 비활성이고 `collector_disabled`로 종료한다. 개발 설정의 `DATABASE_URL`을 사용하며 원본 비밀값을 `.env`에 넣지 않는다. 별도 저장소 없이 매번 임시 브라우저 컨텍스트를 열며, Playwright가 이미 내려받은 Chromium이 있으면 먼저 사용하고 없으면 설치된 Chrome, Edge, Chromium 순서로 찾는다. 필요하면 `INQUIRY_BROWSER_EXECUTABLE`에 실행 파일의 절대 경로를 지정한다.

새 브라우저는 로그인 화면부터 열고 런타임에 주입된 계정 또는 Mac 키체인의 계정으로 자동 로그인한다. 일시 오류는 간격을 둬 제한적으로 재시도하고 한도를 넘으면 5분 대기 후 다시 시도한다. 계정 누락·불완전·명시적 거부는 별도 상태로 표시하며 비밀번호를 계속 제출하지 않는다. 인증 후 `/inquiry-history`에서 정확한 `총 N개` 버튼이 렌더링되어야 수집을 진행한다. 로그인 직후 기본값인 `20개씩`도 인증 완료로 인정하며, 실제 수집 URL에서 `200개씩`을 다시 검증한다. 검증된 조회 범위는 `2000-01-01`부터 실행 당일(KST)까지이며, 삭제되었거나 원본에서 제공하지 않는 자료와 2000년 이전 자료까지 포함한다고 보장하지 않는다.

원본 비밀번호는 사용자 승인으로 macOS 키체인의 `com.evnsolution.evn-marketing.mleverage` 항목에 보관한다. 수집기는 필요할 때만 값을 메모리로 읽으며 코드, `.env`, 명령 인자, 로그에 넣지 않는다. 쿠키, 토큰, storage state, 화면 캡처도 따로 저장하지 않는다. 로그인 입력과 제출 전에는 원본 HTTPS 로그인 주소인지 확인한다. Linux에서는 승인된 런타임 환경에서 `MLEVERAGE_USERNAME`과 `MLEVERAGE_PASSWORD`를 함께 주입한다. 실제 AWS의 비밀값 저장·주입 경로를 만들었다는 의미는 아니다.

worker는 한 프로세스만 180초 생명주기 lease를 얻고, 15초마다 heartbeat를 갱신한다. 수집 중에는 페이지 heartbeat가 같은 lease를 갱신한다. 다른 프로세스는 브라우저를 열기 전에 `worker_already_running`으로 끝난다. 잠자기 뒤 기존 worker만 돌아오면 lease를 다시 얻어 stale 실행을 정리하고 신규 수집 한 건을 예약한다. 새 worker가 먼저 lease를 얻었다면 이전 worker는 브라우저를 닫고 끝난다. 실행 잠금이 만료된 이전 프로세스는 저장과 완료 처리를 할 수 없다. 밀린 횟수만큼 작업을 만들지 않는다.

세션 만료가 확인되면 해당 실행을 `login_required`로 끝내고 같은 복구 정책으로 재로그인한다. 수집기 재시작·로그인 성공만으로 기존 `nextRunAt`을 초기화하거나 예정된 수집을 앞당기지 않는다. 계정 설정을 고친 경우 수집기를 재시작한다. 추가 인증은 원본의 정상 로그인 절차로 처리한다. 2026-09-14 KST 20:29에는 인증 성공, 21:29에는 로그인 필요 상태가 관찰되었지만 정확한 세션 TTL은 확인되지 않았다.

worker CLI는 `login_required`, `page_error`, `lost_lease`, 허용 목록의 `offline_ERR_*` 같은 코드 또는 고정 `worker_error`만 출력한다. 네트워크 진단은 미리 허용한 오류 토큰만 남기며 원본 행, URL, 브라우저·Prisma 오류 본문은 출력하지 않는다.


## WARP 고객관리 전달

`WARP_MARKETING_API_KEY`가 있어도 `WARP_DELIVERY_ENABLED=true`가 아니면 수집만 수행하고 WARP 자동 전송은 하지 않는다. 화면에는 `자동 등록 비활성`이 표시된다. 전용 키는 실행 프로세스의 환경변수로 안전하게 주입하며 `.env`, 명령 인자, 문서, 로그에 넣지 않는다.

2026-09-17 운영 배포된 수신기에 대해 전용 키 인증, 문의 한 건의 등록·재전송 및 실제 CRM 확인을 마치고 로컬 자동 전송을 활성화했다. 키는 숨김 입력으로 받아 앱과 worker의 환경변수로만 전달했으며 파일에 저장하지 않았다. 프로세스 종료나 Mac 재시작 후에는 동일한 키를 안전하게 다시 주입해야 한다.

새 환경의 활성화 절차는 다음과 같다. 자동 전송을 끈 상태에서 `npm run warp:delivery -- check`로 쓰기 없는 인증 검사를 수행한다. 수집 worker를 정상 종료한 뒤 `npm run warp:delivery -- pilot`으로 문의 한 건과 동일 UUID의 재전송을 확인한다. 이어 WARP 고객관리에서 실제 이력과 기존 프로필 보존을 확인한 뒤에만 자동 전송을 활성화한다. 앱과 worker에 같은 활성화 설정을 제공해야 화면과 실행 상태가 일치한다.

활성화 후에는 원본 로그인이 만료되어도 수집기가 실행 중인 동안 저장된 미등록 문의를 전달한다. 한 번에 최대 50건씩 순차 전송하고 검증된 성공 응답만 완료 처리한다. 연결·인증 장애는 전체 전송을 1시간 쉬고, 개별 실패는 1시간 후 다시 시도한다. 연락처 충돌은 자동 재시도하지 않고 운영자 확인까지 보류한다. 원본 수집 주기는 별도로 1시간이다. [운영 연결과 완료 기준](warp-integration.md)을 확인한다.
