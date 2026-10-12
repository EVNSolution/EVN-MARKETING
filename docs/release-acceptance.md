# 배포 인수 검사: 실제 시간과 중단 복구

배포 컨트롤러를 격리된 Linux CI에서 검사합니다. 운영 AWS 자원, 원본 로그인, 실제 고객 DB와 WARP 전송을 사용하지 않습니다. 앱과 합성 수집기는 외부 통신 없는 Docker internal network에 있고, 합성 HTTPS 앞단은 시험 호스트의 loopback에만 연결합니다.

## PR 선택형 검사와 수동 관측

일반 `Marketing CI`는 `npm ci`·production audit·Prisma generate, Python/Node 회귀검사, typecheck·lint, runtime 이미지 빌드와 합성 smoke를 항상 실행합니다. 경로 분류 결과 `compat=true`이면 operations 이미지·구버전 브라우저/동시 업로드 호환 검사·recovery artifact를 추가하고, `controller=true`이면 격리된 Docker controller lab을 추가합니다. controller lab은 A→B→A, 수집기 준비 실패 후 복귀, 진행 중 요청 drain, 배포 프로세스 중단과 journal 복구를 검사합니다. 관측용 가짜 시계만 30배 가속하고 합성 worker lease는 10초입니다. 프로세스 시작·drain·lease 대기는 실제 시간을 사용하며 운영 `WINDOW=1800`, `WORKER_LEASE=180000`은 유지합니다.

이전 수동 workflow는 제거했습니다. 실제 30분 합성 관찰이 필요하면 아래 CLI를 Linux에서 실행합니다. 매 PR이나 매 배포의 필수 검사가 아니며 시간 동작을 변경하거나 문제를 조사할 때 실행합니다. label 자동 실행, 빠른 모드 중복 실행, 자동 재전송이나 주기 실행은 없습니다. lease 180초와 관측 1,800초를 유지합니다. 이 workflow에는 AWS 역할, 운영 environment, 실제 비밀값이 없습니다. 실행 명령은 다음과 같습니다.

```text
docker build --target application --build-arg MARKETING_BUILD_REVISION="$GITHUB_SHA" -t evn-marketing:controller-base .
python3 tests/deploy-controller-lab.py --real-time --report REPORT_PATH
```

실제 시간 경로는 동일한 컨트롤러의 1,800초 관측값을 줄이지 않고 **A→B 한 번**을 실행합니다. `time.time`/`time.monotonic`과 실제 대기를 사용하며 전환 시작부터 commit까지 최소 1,800초인지를 별도로 확인합니다. 이 실행이 필요할 때 PR에서 선택한 가속 rollback·중단 복구 검사를 대체하지 않습니다. 두 경로의 정확한 소스와 성공 결과를 구분합니다.

## CI 시간 관리

- CI concurrency는 PR 또는 브랜치별로 이전 실행을 취소한다. 배포는 취소하지 않는다.
- Markdown도 workflow를 시작하며 경로 분류로 추가 Docker lab을 선택한다.
- runtime, operations, 고정 schema bridge, proxy는 각각 BuildKit GHA cache를 사용한다. operations는 잠금 파일의 Prisma·dotenv·SQLite 의존성만 오프라인으로 남기고 버전·무결성 값이 바뀌지 않았는지 검사한다. Next 빌드 결과를 복사하지 않는다.
- runtime/proxy 준비 후 기본 검사, controller 검사, compatibility 준비·검사를 자동으로 병렬 실행한다. main의 이미지 업로드·scan도 겹쳐 실행하지만 모든 필수 검사 성공 후에만 배포 receipt를 승격한다. 배포는 기존처럼 전체 main CI 성공도 확인한다.
- controller fixture는 동일한 application stage와 기본 OS를 사용하고 사용하지 않는 Chromium만 제외한다. 실제 배포 이미지는 Chromium을 유지하며 기본 검사와 구버전 호환 브라우저 검사를 실행한다.
- 운영 컨트롤러는 정상 응답 3회 사이에 각각 1초를 기다리며 마지막 성공 뒤의 불필요한 대기는 하지 않는다. 스키마 메타데이터는 이미지별 한 컨테이너로 읽지만 DB·migration ledger·integrity는 매 호출 다시 검사한다. 복구 테스트는 이 검증을 마친 컨트롤러의 최종 공개 응답을 독립 확인하고 동일한 시작 대기를 중복하지 않는다.
- 실행자가 선택하는 빠른 모드나 생략 옵션은 없다. 단계별 시간과 controller 명령·대기 시간은 Actions 요약 및 `marketing-ci-timings-*` artifact에 자동 기록된다.
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

- 공개 HTTPS readiness를 전환 전부터 지속 조회합니다. 수동 실제 시간 검사는 HTTP/연결 오류 0, 최소 1,800개 probe, probe 간 최대 공백 5초 미만을 요구하고 응답 지연 p95를 기록합니다. controller 경로의 빠른 lab은 공개 probe 최소 120개, 두 차례 drain, 모든 recovery 시나리오를 유지합니다. 이는 합성 시험 기준이며 운영 SLO나 서버 사양 측정 결과가 아닙니다.
- 두 API 클라이언트가 고객 조회·저장·파일 업로드·다운로드를 동시에 반복합니다. Nginx 내부 경로에 합성 인증 세션을 메모리로만 전달하며, 실패를 재시도해 숨기지 않습니다. 각 성공 응답을 즉시 HTTP·DB·파일과 대조합니다. 문서를 명시적으로 교체하므로 이전 파일의 의도된 삭제와 데이터 유실을 구분합니다. 실제 로그인 UI는 기존 브라우저 검사가 담당합니다.
- 이전 버전으로 전송 중인 multipart 요청을 일부러 열어 두고 매핑을 만료시킵니다. 구 Nginx worker가 요청 완료 전까지 유지되는 것을 확인한 다음 나머지 body를 보냅니다. 이전 slot에서 HTTP 200을 받고 파일을 읽을 수 있어야 drain 성공입니다. 이는 실제 진행 요청 검사이며 180초 drain 한도 전체의 부하 시험은 아닙니다.
- 복구 helper는 실제 별도 프로세스의 강제 종료, 호스트 잠금 경쟁, 저장된 journal 재읽기, 컨테이너 중단 후 재시작을 사용합니다. 정상 종료 경로를 호출한 결과만으로 crash 복구를 주장하지 않습니다. 확인한 상세 시나리오는 결과 JSON의 recovery 항목으로 남깁니다.

수동 CLI의 실제 시간 검사 결과는 지정한 REPORT_PATH에 집계 JSON으로 저장합니다. 보고서의 mode와 lease가 PR의 합성 가속 lab 결과와 실제 시간 검증을 구분합니다. 소스 SHA, 합성 이미지 digest, 경과 시간, 요청 수/오류/지연, drain 결과를 담고 세션·비밀값·고객 내용·DB·전체 journal은 업로드하지 않습니다. 실패나 취소는 성공 보고서를 만들지 않습니다.

## 남는 운영 경계

컨테이너 정지/재시작은 **OS 재부팅이 아닙니다**. CI 프로세스 사망은 실제 AWS SSM 연결 중단이 아닙니다. 실제 host boot ordering, systemd 자동 복구, SSM 실행 중단·명령 결과 유실, 실제 원본 서비스의 장기 로그인, 모든 Z01–Z09 조합은 운영 준비 환경에서 별도 확인해야 합니다. 두 fixture는 현재 소스에 합성 revision을 부여하므로 서로 다른 소스 버전의 호환성 증거는 기존 브라우저 검사와 구분합니다. 백업·복원의 실운영 검증은 별도입니다.
