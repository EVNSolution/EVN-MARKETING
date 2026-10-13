# 배포 인수 검사: 실제 시간과 중단 복구

배포 컨트롤러를 격리된 Linux CI에서 검사합니다. 운영 AWS 자원, 원본 로그인, 실제 고객 DB와 WARP 전송을 사용하지 않습니다. 앱과 합성 수집기는 외부 통신 없는 Docker internal network에 있고, 합성 HTTPS 앞단은 시험 호스트의 loopback에만 연결합니다.

## 자동 선택 검사

일반 `Marketing CI`는 의존성 설치·production audit·Prisma generate, 회귀검사, typecheck·lint, runtime 이미지 빌드와 합성 smoke를 항상 실행합니다. 경로 분류가 `compat=true`이면 구버전 브라우저·동시 업로드 검사를 추가합니다. `controller=true`이면 격리 Docker controller lab을 추가합니다.

controller lab은 실제 시계로 A→B→C→B→A를 연속 실행합니다. 고정 보호 시간이나 시계 이동 없이 다음 배포·rollback을 진행합니다. 각 초기 검증은 공개 응답 최소 5회와 worker heartbeat 갱신을 요구하며 90초 미만이어야 합니다. 진행 중 업로드 drain 2회, 활성화 이후 worker 실패 복귀, 데이터 보존, 중단 복구 8개 시나리오를 검사합니다. 합성 worker lease는 10초이며 운영 lease 180초는 유지합니다.

고정 30분 관찰, 가속 시계, 별도 `--real-time` 모드는 제거했습니다. 초기 검증이 끝나도 직전 화면 매핑은 유지합니다. 이후 슬롯 재사용에서만 매핑을 제거하고 요청 drain을 확인합니다. Linux CI가 자동 실행하며 실행자의 선택은 필요 없습니다.

## CI 시간 관리

- CI concurrency는 PR 또는 브랜치별로 이전 실행을 취소한다. 배포는 취소하지 않는다.
- Markdown도 workflow를 시작하며 경로 분류로 추가 Docker lab을 선택한다.
- runtime, operations, 고정 schema bridge, proxy는 각각 BuildKit GHA cache를 사용한다. operations는 잠금 파일의 Prisma·dotenv·SQLite 의존성만 오프라인으로 남기고 버전·무결성 값이 바뀌지 않았는지 검사한다. Next 빌드 결과를 복사하지 않는다.
- 배포용 runtime은 application 작업에서 한 번 빌드하고 같은 환경에서 검사·게시한다. controller 전용 application 이미지는 같은 소스 SHA로 병렬 빌드한 뒤 두 controller 작업에 전달한다. Chromium 이미지의 중복 전송·재로딩을 하지 않는다. application, controller transitions, controller recovery를 독립된 실행 환경에 자동 배정한다. application의 두 브라우저 검사는 자원 경쟁을 피하려고 한 번에 하나만 실행한다. main 이미지 업로드·scan은 병행한다.
- 최종 images gate는 verify·plan·application과 자동으로 필요한 controller 작업의 성공을 확인한다. controller가 필요하면 두 보고서의 소스 SHA, 진행 중 업로드 2회, 공개 응답 오류 0, 실제 시계의 초기 검증 4회와 정확한 전환 순서, 복구 8개 시나리오와 신규 데이터 보존 8회를 대조한다. 모두 성공해야 배포 receipt를 승격한다. 누락·취소·예상하지 않은 skipped는 실패한다.
- recovery 작업은 실제 API로 기본 데이터를 만든 뒤 한 DB에서 8개 시나리오를 순서대로 실행한다. 이전 시나리오와 중단 후 새로 기록한 고객·업로드·전송 이력을 모두 보존해야 한다. transitions 작업은 별도 DB에서 A→B→C→B→A와 활성화 이후 worker 실패·진행 중 업로드를 검사한다. 전송용 이미지 artifact는 1일, 검사 증거는 7일 보관한다.
- controller fixture는 같은 소스의 application stage와 기본 OS를 사용하고 사용하지 않는 Chromium만 제외한다. 실제 배포 이미지는 Chromium을 유지하며 기본 검사와 구버전 호환 브라우저 검사를 실행한다.
- 운영 컨트롤러는 정상 응답 3회 사이에 각각 1초를 기다리며 마지막 성공 뒤의 불필요한 대기는 하지 않는다. 스키마 메타데이터는 이미지별 한 컨테이너로 읽지만 DB·migration ledger·integrity는 매 호출 다시 검사한다. 복구 테스트는 이 검증을 마친 컨트롤러의 최종 공개 응답을 독립 확인하고 동일한 시작 대기를 중복하지 않는다.
- 실행자가 선택하는 빠른 모드나 생략 옵션은 없다. 애플리케이션 단계 시간은 Actions 요약과 `marketing-ci-timings-*`에 기록한다. controller 명령·대기 시간과 검사 결과는 `controller-transitions-*`·`controller-recovery-*` artifact에 자동 기록한다.
- 호환 브라우저 fixture는 HTTP 헤더를 보내지 않은 유휴 연결만 5초로 제한한다. 운영 프록시 설정, 요청 본문·응답·drain 제한과 진행 중 업로드 검사는 유지한다.
- main CI의 검증 이미지를 배포에서 그대로 사용한다. 배포에서는 재빌드하지 않는다.
- 분류 경계 selftest와 workflow YAML parse를 확인하고 Linux CI에서 실제 선택된 경로·시나리오 수·실행 시간을 기록합니다. 최종 선택형 CI의 시간 실측치는 해당 실행 이후에만 기재합니다.
- 비교 기록은 [이전 PR checks 17분 45초·lab 11분 01초](https://github.com/EVNSolution/EVN-MARKETING/actions/runs/35807195118), [최근 PR checks 12분 09초·lab 5분 19초](https://github.com/EVNSolution/EVN-MARKETING/actions/runs/35811912599), [중복되던 수동 빠른 인수 8분 25초](https://github.com/EVNSolution/EVN-MARKETING/actions/runs/35811915367)입니다. 모두 이번 선택형 CI 이전 실행이며 새 시간의 예측값은 아닙니다.

| 변경 경로 | 추가 검사 선택 |
| --- | --- |
| 일반 화면 코드 | `compat` — operations 이미지·브라우저 호환·recovery artifact |
| 명시된 호스트 배포·worker 코드 | `controller` — 격리 Docker controller lab |
| `deploy/aws/release.py`, `deploy/aws/operator-release.py`, 해당 cloud/manual/operator 테스트 | 추가 Docker lab 없음. 관련 단위 테스트·runtime 빌드·smoke는 유지 |
| 공유 dependency·API/auth/schema·CI 설정, 미분류 경로 | `compat`와 `controller` 모두 |

실행자가 아닌 [분류 스크립트](../.github/scripts/classify_pr.py)가 Git 변경 전체를 평가합니다.
여러 종류를 변경하면 필요한 검사를 합칩니다. rename은 이전·새 경로를 모두 평가합니다.
push 이력 재작성·diff 추출 실패·빈 변경·`Marketing CI` 수동 dispatch는 두 경로를 모두 실행합니다.
새 파일은 기존 경로 규칙에 해당하지 않으면 두 검사를 실행합니다. deploy 폴더 전체를 생략하지 않습니다.
분류 코드·분류 테스트·workflow 변경도 두 검사를 실행합니다. 분류 출력이 잘못되면 CI를 실패시킵니다.
비교 SHA·경로별 이유·최종 결정은 Actions 요약에 자동 기록합니다. 검사 생략 입력이나 label은 없습니다.

## 확인하는 내용

- 공개 HTTPS readiness를 전환 전부터 지속 조회하여 HTTP/연결 오류 0을 요구합니다. 각 초기 검증은 정상 응답 5회 이상, worker heartbeat 갱신, 경과 시간 8초 이상·90초 미만을 보고해야 합니다. 최종 gate는 네 전환의 개별 증거를 대조합니다. 이는 합성 시험 기준이며 운영 SLO나 서버 사양 측정 결과가 아닙니다.
- 두 API 클라이언트가 고객 조회·저장·파일 업로드·다운로드를 동시에 반복합니다. Nginx 내부 경로에 합성 인증 세션을 메모리로만 전달하며, 실패를 재시도해 숨기지 않습니다. 각 성공 응답을 즉시 HTTP·DB·파일과 대조합니다. 문서를 명시적으로 교체하므로 이전 파일의 의도된 삭제와 데이터 유실을 구분합니다. 실제 로그인 UI는 기존 브라우저 검사가 담당합니다.
- 이전 버전으로 전송 중인 multipart 요청을 일부러 열어 두고 다음 배포의 슬롯 재사용을 위해 매핑을 제거합니다. 구 Nginx worker가 요청 완료 전까지 유지되는 것을 확인한 다음 나머지 body를 보냅니다. 이전 slot에서 HTTP 200을 받고 파일을 읽을 수 있어야 drain 성공입니다. 이는 실제 진행 요청 검사이며 180초 drain 한도 전체의 부하 시험은 아닙니다.
- 복구 helper는 실제 별도 프로세스의 강제 종료, 호스트 잠금 경쟁, 저장된 journal 재읽기, 컨테이너 중단 후 재시작을 사용합니다. 정상 종료 경로를 호출한 결과만으로 crash 복구를 주장하지 않습니다. 확인한 상세 시나리오는 결과 JSON의 recovery 항목으로 남깁니다.

각 CI 작업은 지정한 보고서에 집계 JSON을 저장합니다. 소스 SHA, 합성 이미지 digest, 전환 순서, 초기 검증 시간·조건, 요청 수/오류, drain 결과를 담습니다. 세션·비밀값·고객 내용·DB·전체 journal은 업로드하지 않습니다. 실패나 취소는 성공 보고서를 만들지 않습니다.

## 남는 운영 경계

컨테이너 정지/재시작은 **OS 재부팅이 아닙니다**. CI 프로세스 사망은 실제 AWS SSM 연결 중단이 아닙니다. 실제 host boot ordering, systemd 자동 복구, SSM 실행 중단·명령 결과 유실, 실제 원본 서비스의 장기 로그인, 모든 Z01–Z09 조합은 운영 준비 환경에서 별도 확인해야 합니다. 세 fixture는 현재 소스에 합성 revision을 부여하므로 서로 다른 소스 버전의 호환성 증거는 기존 브라우저 검사와 구분합니다. 백업·복원의 실운영 검증은 별도입니다.
