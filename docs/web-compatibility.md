# 웹 버전 호환성과 동시 업로드

M2의 웹 호환성·파일 용량 경쟁을 구현하고 검사합니다. 운영 배포나 M2/Z02/Z07/Z08 전체 완료를 뜻하지 않습니다.

## 버전 계약

Docker 빌드에 `--build-arg MARKETING_BUILD_REVISION=<40자리 소스 SHA>`를 지정합니다. `deploymentId`, 브라우저 상수와 `X-Marketing-Release` 응답 헤더에 같은 값을 고정하며 런타임 환경이나 쿠키로 바꾸지 않습니다. 동일 릴리스는 한 번 만든 이미지를 공유하고, 서로 다른 빌드의 Server Action 암호키를 공유하지 않습니다.

배포용 빌드는 `next build --webpack`을 사용합니다. 기존 Noto Sans KR/Jost 글꼴을 프로젝트에 포함하여 빌드 시 외부 글꼴 요청이 필요하지 않습니다. 출처와 라이선스는 `app/fonts/licenses/`에 보존하며 실행 이미지에도 함께 제공합니다.

Next의 [deploymentId](https://nextjs.org/docs/app/api-reference/config/next-config-js/deploymentId)는 asset의 `dpl` 및 클라이언트 요청의 버전 header를 제공하지만 프록시 라우팅을 대신하지 않습니다. 로그인·로그아웃은 React [useActionState의 permalink](https://react.dev/reference/react/useActionState#parameters)를 사용해 JS 로드 전/비활성 상태에도 form POST URL에 렌더링된 ID를 넣습니다. React의 SSR action 필드와 인코딩을 유지합니다. 로그인 성공은 서버 redirect로 처리하여 JS 없이도 고객 목록으로 이동합니다.

`deploy/nginx-config.mjs`는 active 및 유효한 previous ID만 고정 blue/green upstream에 매핑합니다. 임의 입력은 호스트명·파일 경로가 될 수 없습니다. URL/header 충돌·중복·미등록 ID, 버전 없는 action은 409로 거부합니다. asset/RSC/action, 고객·문의 쓰기와 `/api/release`는 버전을 구분하고, 일반 문서는 active로 갑니다. `/api/readyz`는 항상 active를 확인합니다.

문서 응답의 `marketing_release` 쿠키는 보조 표시입니다. 쓰기/action의 누락 ID를 쿠키로 추정하지 않아 새 탭의 쿠키 변경이 이전 탭의 명시적 ID를 덮어쓰지 못합니다. ID는 인증 권한이 아니며 기존 NextAuth 세션과 동일 `AUTH_SECRET`을 유지합니다.

JS form과 화면 이동은 `/api/release`를 확인한 뒤 진행합니다. 만료 시 화면과 입력을 유지하고 갱신 안내를 표시합니다. REST 쓰기는 버전 header를 보내며 409를 자동 재시도하지 않습니다. 저장/활동/삭제 실패를 성공으로 반영하지 않습니다. 새로고침은 입력 손실 확인 후 실행하며 고객 내용을 추가 브라우저 저장소에 기록하지 않습니다. JS 없는 만료 form은 작업을 실행하지 않는 안내 페이지를 반환합니다.

## 적용 범위와 후속 작업

- 이 계약을 구현한 두 릴리스 사이의 호환입니다. PR #6 이전의 버전 정보 없는 화면은 최초 도입 시 별도 이전/재접속 창이 필요합니다.
- 생성기는 명시된 previous 매핑을 시간 제한 없이 유지합니다. 다음 전진 배포가 슬롯을 재사용할 때 컨트롤러가 매핑을 제거하고 설정 검사·reload·진행 요청 drain을 완료합니다. 초기 검증과 별개이며 이전 화면 보호 때문에 다음 배포를 기다리지 않습니다.
- 사전 확인과 실제 요청 사이에도 만료될 수 있으므로 최종 프록시의 거부가 기준입니다. 사전 확인은 인증이나 인계 잠금이 아닙니다. 문의 확인과 실제 RSC 요청 사이에 만료되어 Next가 전체 이동으로 바꾸는 경우, 편집한 화면은 beforeunload 확인으로 입력의 조용한 폐기를 막습니다. 저장 뒤에도 전체 이동에서는 보수적으로 확인이 표시될 수 있습니다. 로그아웃 action 실패는 해당 form의 오류 경계로 격리하여 고객 편집 화면을 유지합니다.
- 현재 설정은 private upstream의 HTTP 계약/합성 검증용입니다. 공개 HTTPS·방화벽·인증서·배포 환경의 proxy 신뢰 경계는 M3/M5에서 구성합니다. 앱 포트를 직접 공개하지 않습니다.
- 최초 PR #7 검사는 같은 변경본을 서로 다른 ID/독립 action 키로 두 번 빌드했습니다. 후속 [DB 호환성 검사](data-compatibility.md)는 PR #7 고정 source와 현재 source의 실제 두 코드 버전을 빌드해 전환합니다. 현재 schema는 동일하며, 향후 REST/schema 변경 시 해당 N/N-1 조합을 다시 검사해야 합니다. 모든 과거 버전의 호환성을 보장하지 않습니다.

## 공용 업로드 제한

파일 검증·메모리 로드 후 기존 SQLite Customer 행에 값이 바뀌지 않는 UPDATE로 writer 잠금을 얻습니다. 디스크 용량 확인과 배타적 파일 쓰기를 같은 트랜잭션에서 처리합니다. 디렉터리 확인 중 트랜잭션이 만료되면 파일을 열기 전 재확인으로 거부합니다. 쓰기는 최대 10 MiB의 동기 작업이며 같은 프로세스 업로드도 직렬화합니다. 새 테이블·외부 잠금 서비스를 추가하지 않습니다.

SQLite는 모든 writer를 직렬화하므로 다른 고객 저장도 잠깐 기다릴 수 있습니다. 실제 peak 지연/메모리 측정은 후속 단계입니다. 프로세스 종료 시 DB 잠금은 해제됩니다. DB 반영 전 남은 파일·삭제 준비 파일도 실제 제거될 때까지 50 MiB에 포함합니다. 기존 metadata 변경 충돌 검사와 실패 시 새 파일 제거를 유지합니다. 서로 다른 DB/네트워크 파일시스템으로 확장할 때 같은 보장을 주장하지 않습니다.

프록시는 본문을 10 MiB + 64 KiB로 제한하고 앱은 파일당 10 MiB·고객별 총량 50 MiB·형식·소유권을 재검사합니다.

## 검사와 증거

- `test:upload-security` / `test:upload-processes`: 소유권·rollback·실제 프로세스 경쟁, 잠금 중 강제 종료, 남은 파일 용량 산정, 만료 트랜잭션의 파일 쓰기 차단.
- `test:release-routing`: 허용된 릴리스/슬롯과 정확한 만료 경계.
- Linux `tests/release-compat.sh`: 두 독립 이미지, 실제 Nginx/Chromium, 공유 합성 DB/업로드를 사용합니다. 고정 PR #7의 앱 소스/lockfile은 유지하고 Docker 빌드 단계에만 Python/make/g++를 추가하여 SQLite 사전 빌드 바이너리를 받지 못해도 소스 빌드가 가능합니다. 현재 이미지도 같은 빌드 도구를 갖추며 실행 이미지에는 추가하지 않습니다. 컨테이너는 외부 통신 없는 internal network에서 실행하고 운영 데이터·로그인·키를 사용하지 않습니다.
- hydrated/native/JS 비활성/JS 로드 차단 로그인·로그아웃, 여러 탭/쿠키 변경, 이전 탭 저장·업로드·RSC/lazy asset, 세션, 만료 후 입력 보존·재전송 없음·readyz active 고정을 검사합니다.
- 두 이미지가 남은 용량을 동시에 사용하도록 HTTP 업로드하여 정확히 하나가 성공하는지, 50 MiB 한도·기존 파일·metadata·병렬 고객 저장·DB 무결성을 확인합니다.

실제 결과는 구현 PR의 CI 링크로 기록합니다. 운영 서버의 초기 검증·장애 복귀·재부팅·백업·이전 슬롯 재사용 증거는 CI와 구분합니다.
