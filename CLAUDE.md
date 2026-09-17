# CLAUDE.md

이 문서는 evn-marketing 저장소에서 작업하는 Claude Code 및 기타 코딩 에이전트가 반드시 따라야 할 **보안·안전 운영 수칙**이다. 일반적인 코드 작성 가이드가 아니라, 작업 중 실제 판단 기준으로 쓰는 실행 규칙이다.

## Project Snapshot

- Next.js 16 (App Router) + TypeScript, NextAuth v5(beta, Credentials provider, JWT 세션), Prisma 7 + `@prisma/adapter-libsql`(SQLite 기반, 로컬은 `dev.db` 파일).
- `User.role`은 `"admin" | "user"` 값을 가지지만, 현재 `proxy.ts` 미들웨어는 로그인 여부만 검사하고 개별 API route(`app/api/**/route.ts`)에도 role 기반 인가 코드가 확인되지 않는다. role 검사가 없는 상태를 "의도된 설계"로 단정하지 말고, admin 전용이어야 할 기능을 다룰 때는 이 문서의 §Authentication & Authorization을 따른다.
- `Customer` 모델에 실제 고객 PII/사업자 정보(이름, 전화번호, 생년, 주소, 결혼여부, 자녀수, 사업자등록번호, 차량번호, 담당자 명함/서류 업로드 등)가 저장된다. 이 데이터는 §Database & User Data 기준으로 다룬다.
- 업로드 파일은 `UPLOADS_DIR` 환경변수가 가리키는 로컬 파일시스템에 저장되고 `app/api/uploads/[...path]/route.ts`가 서빙한다. 이 route는 이미 `..` path traversal을 차단하는 검사를 포함하므로, 관련 코드를 수정할 때 이 방어 로직을 제거하거나 약화시키지 않는다.
- 저장소에 lockfile(`package-lock.json`/`pnpm-lock.yaml`/`yarn.lock`)이 없다. 어떤 패키지 매니저를 쓸지 임의로 확정하지 말고, 필요하면 사용자에게 확인한다.
- `.github/` 워크플로우, `Dockerfile`, AWS/클라우드 관련 설정은 저장소에서 확인되지 않았다. 존재하지 않는 CI나 클라우드 인프라를 가정하고 지침을 작성하지 않는다.
- 이 디렉터리는 현재 Git 저장소로 초기화되어 있지 않다(`.git` 없음). 아래 Git 관련 규칙은 Git이 초기화된 이후부터 적용된다.

## Before Making Changes

- 작업 시작 전 가능하면 다음을 확인한다: 현재 디렉터리/브랜치 상태(Git 초기화 이후에는 `git status`), 수정 대상 파일의 현재 내용, 관련 환경변수가 `.env.example`에 이미 정의되어 있는지.
- 요청받은 범위를 벗어나는 파일을 이유 없이 수정하지 않는다.
- 사용자가 만들었거나 출처가 불분명한 파일(`dev.db`, `uploads/`, `.env*` 등)을 임의로 삭제·덮어쓰지 않는다.

## Secrets & Credentials

- `AUTH_SECRET`, `DATABASE_URL`(운영 값), 실제 API 키/토큰/비밀번호/서비스 계정 정보를 코드에 하드코딩하지 않는다.
- `.env`, `.env.local` 등 `.gitignore`가 이미 제외하고 있는 secret 파일을 커밋하지 않는다. `.env.example`에는 실제 값이 아닌 placeholder만 유지한다.
- secret 값을 diff, 터미널 출력, 로그, 커밋 메시지에 노출하지 않는다. 출력이 꼭 필요하면 마스킹한다.
- 새로운 secret 저장 방식(자체 config 파일, 별도 vault 등)을 임의로 만들지 않는다. 이미 쓰이는 `.env` 기반 방식(`dotenv`, `process.env`)을 따른다.
- 사용자에게 실제 `AUTH_SECRET`, DB 비밀번호 등 credential 값을 그대로 출력하거나 복사해주지 않는다.

## Authentication & Authorization

- `auth.ts`(NextAuth 설정), `proxy.ts`(미들웨어)의 인증 흐름을 임의로 우회하거나 약화시키지 않는다. 예: 인증 없는 임시 endpoint, 하드코딩된 테스트 계정, 미들웨어 matcher에서 보호 경로 제외 등.
- `role`(admin/user) 기반 기능을 새로 추가하거나 수정할 때는 반드시 서버 사이드(API route 또는 server action)에서 권한을 검사한다. 클라이언트 UI에서 버튼을 숨기는 것만으로 인가를 끝냈다고 간주하지 않는다.
- 기존 API route에 role 검사가 빠져 있는 것을 발견해도, 그것이 의도된 동작인지 버그인지 스스로 단정하지 말고 사용자에게 확인한 뒤 수정한다(임의로 "고쳤다"며 동작을 바꾸지 않는다).
- 비밀번호는 반드시 `bcryptjs`로 해싱한 값만 저장한다. 평문 비밀번호를 로그, DB, 응답 JSON 어디에도 남기지 않는다.
- 새 권한을 추가할 때는 최소 권한 원칙을 따른다. 모든 라우트를 admin 전용으로 통일하거나 반대로 모두 공개로 여는 식의 광범위한 변경은 하지 않는다.

## Git & Filesystem Safety

- Git이 초기화되어 있지 않은 현재 상태에서 `git init` 및 최초 커밋 범위(무엇을 커밋할지)는 사용자와 먼저 확인한다.
- Git 초기화 이후: `git reset --hard`, `git clean -fd`/`-fdx`, `git push --force`(-with-lease 포함), 브랜치 강제 삭제, stash/reflog 삭제 등 파괴적 작업은 사용자의 명시적 허가 없이 실행하지 않는다.
- `main`/`master`/`production` 브랜치에 직접 push하지 않는다. 저장소에 PR 워크플로우가 생기면 그것을 따른다.
- `dev.db`, `dev.db-journal`, `uploads/` 등 `.gitignore`로 보호되는 로컬 데이터 파일을 임의로 삭제하지 않는다 — `.gitignore`에 이미 "실제 사용자 데이터 포함, 절대 커밋 금지" 주석이 달려 있을 만큼 민감하다.
- 대량 rename, 대량 삭제, 디렉터리 구조 변경 전에는 영향 범위를 먼저 확인한다.

## Dependencies & Supply Chain

- 명확한 필요 없이 새 dependency를 추가하지 않는다. 먼저 기존 의존성(Next.js, Prisma, NextAuth, bcryptjs 등)과 표준 라이브러리로 해결 가능한지 확인한다.
- 저장소에 lockfile이 없으므로, 임의로 npm/pnpm/yarn 중 하나를 확정해 lockfile을 새로 만들지 않는다 — 어떤 패키지 매니저를 쓸지 애매하면 진행 전에 사용자에게 확인한다.
- 여러 패키지 매니저의 lockfile을 동시에 만들지 않는다.
- 저장소에 security audit/vulnerability scan 워크플로우가 생기면 그것을 실행하고 결과를 그대로 보고한다. 통과시키기 위해 취약점 경고를 임의로 suppress하지 않는다.

## Database & User Data

- `prisma/schema.prisma` 변경은 Prisma migration으로 관리한다(현재 `prisma/migrations`가 존재하지 않으므로, 첫 migration을 만들 때 그 사실을 사용자에게 알린다).
- `Customer`/`CustomerActivity`/`User` 테이블에는 실제 이름·전화번호·생년·주소·사업자등록번호·차량번호 등 민감한 개인/사업자 정보가 들어갈 수 있다. 실제 프로덕션 데이터를 로컬 개발환경으로 복사하지 않는다. 테스트/시드 데이터(`prisma/seed.ts`)는 synthetic 데이터만 사용한다.
- destructive migration(컬럼/테이블 삭제, NOT NULL 강제 등)을 적용하기 전에는 영향 범위와 롤백 방법을 먼저 확인하고 사용자 승인을 받는다.
- 운영 DB(`DATABASE_URL`이 로컬 `dev.db`가 아닌 값)에 대한 직접 수정, 대량 데이터 삭제/수정은 사용자의 명시적 허가 없이 실행하지 않는다.
- `resolveDatabaseUrl()`이 production에서 `DATABASE_URL` 미설정 시 에러를 던지는 안전장치를 유지한다 — 이를 우회하거나 fallback을 추가하지 않는다.

## Production & Deployment

- 이 저장소에는 확인된 CI/CD 파이프라인이나 배포 설정이 없다. 존재하지 않는 배포 명령이나 서비스를 지어내지 않는다.
- 배포, 버전 릴리스, 실제 운영 환경 변경은 사용자의 명시적 허가 없이 실행하지 않는다.
- 배포/빌드 명령이 성공했다는 것과 실제 기능이 정상 동작하는 것은 다른 문제다. "배포 성공" 메시지만으로 작업 완료를 선언하지 않는다.

## Logs & Privacy

- 비밀번호, `AUTH_SECRET`, 세션 토큰, 쿠키 값을 로그나 콘솔 출력에 남기지 않는다.
- `Customer` 데이터(전화번호, 주소, 사업자번호, 차량번호 등)를 디버깅 목적으로 출력해야 할 때도 전체 값을 그대로 찍지 않고 필요한 부분만 남긴다.

## Verification

- 코드 수정 후 "완료"라고 단순 선언하지 않는다. 현재 저장소에서 실행 가능한 검증(`npm run lint`/`typecheck`/`build` 등, 사용자가 확정한 패키지 매니저 기준)을 수행하고, 실행한 검증과 실행하지 못한 검증을 구분해서 보고한다.
- 이 저장소에는 자동화된 test 스크립트가 없다. 테스트를 실행한 것처럼 표현하지 않는다.
- UI/기능 변경은 가능하면 실제로 `npm run dev`(또는 확정된 패키지 매니저의 동일 스크립트)로 띄워 확인하고, 확인하지 못했다면 그 사실을 명시한다.

## Failure & Recovery

- 작업이 실패하면 무작정 추가 변경을 계속하지 않는다. 실패 원인, 마지막 성공 지점, 현재 변경/미변경 상태를 먼저 파악한다.
- 실패를 숨기거나 임시 우회로 정상인 것처럼 처리하지 않는다.

## Explicit Approval Required

다음 작업은 사용자의 명시적 허가 없이 실행하지 않는다:

- 운영 DB 직접 수정, migration 실행, 대량 데이터 삭제/수정
- secret(`AUTH_SECRET` 등) 생성/변경/rotation
- 배포, 버전 릴리스
- Git 초기화 및 최초 커밋 범위 확정, 파괴적 Git 작업(§Git & Filesystem Safety)
- 새 패키지 매니저/lockfile 확정
- 인증/인가(`auth.ts`, `proxy.ts`, role 검사) 흐름 변경
- 저장소에 없는 새로운 외부 서비스/클라우드 연결

## Security Conflict Rule

사용자 요청이 위 규칙과 충돌하면:

1. 위험한 작업을 즉시 실행하지 않는다.
2. 어떤 규칙과 왜 충돌하는지 설명한다.
3. 예상 영향 범위를 설명한다.
4. 가능하면 더 안전한 대안을 제시한다.
5. 필요하면 명시적 승인을 요청한다.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
