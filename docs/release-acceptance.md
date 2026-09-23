# 배포 인수 검사: 실제 시간과 중단 복구

배포 컨트롤러를 격리된 Linux CI에서 검사합니다. 운영 AWS 자원, 원본 로그인, 실제 고객 DB와 WARP 전송을 사용하지 않습니다. 앱과 합성 수집기는 외부 통신 없는 Docker internal network에 있고, 합성 HTTPS 앞단은 시험 호스트의 loopback에만 연결합니다.

## PR 선택형 검사와 수동 관측

일반 `PR checks`는 `npm ci`·production audit·Prisma generate, Python/Node 회귀검사, typecheck·lint, runtime 이미지 빌드와 합성 smoke를 항상 실행합니다. 경로 분류 결과 `compat=true`이면 operations 이미지·구버전 브라우저/동시 업로드 호환 검사·recovery artifact를 추가하고, `controller=true`이면 격리된 Docker controller lab을 추가합니다. controller lab은 A→B→A, 수집기 준비 실패 후 복귀, 진행 중 요청 drain, 배포 프로세스 중단과 journal 복구를 검사합니다. 관측용 가짜 시계만 30배 가속하고 합성 worker lease는 10초입니다. 프로세스 시작·drain·lease 대기는 실제 시간을 사용하며 운영 `WINDOW=1800`, `WORKER_LEASE=180000`은 유지합니다.

별도 `30-minute release observation (manual)`은 `workflow_dispatch`로 명시적으로 실행하는 실제 30분 관측 전용입니다. 매 PR이나 매 배포의 필수 검사가 아니며 시간 동작을 변경하거나 문제를 조사할 때 실행합니다. label 자동 실행, 빠른 모드 중복 실행, 자동 재전송이나 주기 실행은 없습니다. lease 180초와 관측 1,800초를 유지합니다. 이 workflow에는 AWS 역할, 운영 environment, 실제 비밀값이 없습니다. 실행 명령은 다음과 같습니다.

```text
python3 tests/deploy-controller-lab.py --real-time --report REPORT_PATH
```

실제 시간 경로는 동일한 컨트롤러의 1,800초 관측값을 줄이지 않고 **A→B 한 번**을 실행합니다. `time.time`/`time.monotonic`과 실제 대기를 사용하며 전환 시작부터 commit까지 최소 1,800초인지를 별도로 확인합니다. 이 실행이 필요할 때 PR에서 선택한 가속 rollback·중단 복구 검사를 대체하지 않습니다. 두 경로의 정확한 소스와 성공 결과를 구분합니다.

## CI 시간 관리

- `PR checks`의 concurrency는 workflow와 PR 번호 또는 브랜치로 구분하고 `cancel-in-progress: true`로 둡니다. PR `closed` 이벤트는 새 무거운 job을 시작하지 않으며 이전 run을 취소합니다.
- Markdown만 바뀐 PR은 `paths-ignore`로 workflow가 시작되지 않습니다. 다른 변경과 함께 들어온 Markdown, 알려진 `app/`·`components/` CSS와 `app/fonts/` 폰트·라이선스는 경로 분류상 fast만 실행합니다. 미분류 CSS·폰트는 두 추가 경로를 모두 실행합니다.
- runtime/operations Docker 빌드는 같은 runner의 Docker layer를 재사용하며 원격 cache 전송은 사용하지 않습니다. 이미지 tar 적재와 원격 cache 최초 저장 비용이 기존 직접 빌드보다 컸고 PR별 cache 공유에도 제약이 있어 채택하지 않았습니다.
- 분류 경계 selftest와 workflow YAML parse를 확인하고 Linux CI에서 실제 선택된 경로·시나리오 수·실행 시간을 기록합니다. 최종 선택형 CI의 시간 실측치는 해당 실행 이후에만 기재합니다.
- 비교 기록은 [이전 PR checks 17분 45초·lab 11분 01초](https://github.com/EVNSolution/EVN-MARKETING/actions/runs/35807195118), [최근 PR checks 12분 09초·lab 5분 19초](https://github.com/EVNSolution/EVN-MARKETING/actions/runs/35811912599), [중복되던 수동 빠른 인수 8분 25초](https://github.com/EVNSolution/EVN-MARKETING/actions/runs/35811915367)입니다. 모두 이번 선택형 CI 이전 실행이며 새 시간의 예측값은 아닙니다.

| 변경 경로 | 추가 검사 선택 |
| --- | --- |
| 일반 화면 코드 | `compat` — operations 이미지·브라우저 호환·recovery artifact |
| 배포·worker 코드 | `controller` — 격리 Docker controller lab |
| 공유 dependency·API/auth/schema·CI 설정, 미분류 경로 | `compat`와 `controller` 모두 |

rename은 이전·새 경로를 모두 평가합니다. diff 추출 실패·빈 변경·`PR checks` 수동 dispatch도 두 경로를 모두 실행합니다. [분류 스크립트](../.github/scripts/classify_pr.py)

## 확인하는 내용

- 공개 HTTPS readiness를 전환 전부터 지속 조회합니다. 수동 실제 시간 검사는 HTTP/연결 오류 0, 최소 1,800개 probe, probe 간 최대 공백 5초 미만을 요구하고 응답 지연 p95를 기록합니다. controller 경로의 빠른 lab은 공개 probe 최소 120개, 두 차례 drain, 모든 recovery 시나리오를 유지합니다. 이는 합성 시험 기준이며 운영 SLO나 서버 사양 측정 결과가 아닙니다.
- 두 API 클라이언트가 고객 조회·저장·파일 업로드·다운로드를 동시에 반복합니다. Nginx 내부 경로에 합성 인증 세션을 메모리로만 전달하며, 실패를 재시도해 숨기지 않습니다. 각 성공 응답을 즉시 HTTP·DB·파일과 대조합니다. 문서를 명시적으로 교체하므로 이전 파일의 의도된 삭제와 데이터 유실을 구분합니다. 실제 로그인 UI는 기존 브라우저 검사가 담당합니다.
- 이전 버전으로 전송 중인 multipart 요청을 일부러 열어 두고 매핑을 만료시킵니다. 구 Nginx worker가 요청 완료 전까지 유지되는 것을 확인한 다음 나머지 body를 보냅니다. 이전 slot에서 HTTP 200을 받고 파일을 읽을 수 있어야 drain 성공입니다. 이는 실제 진행 요청 검사이며 180초 drain 한도 전체의 부하 시험은 아닙니다.
- 복구 helper는 실제 별도 프로세스의 강제 종료, 호스트 잠금 경쟁, 저장된 journal 재읽기, 컨테이너 중단 후 재시작을 사용합니다. 정상 종료 경로를 호출한 결과만으로 crash 복구를 주장하지 않습니다. 확인한 상세 시나리오는 결과 JSON의 recovery 항목으로 남깁니다.

수동 실제 시간 검사 성공 시 `marketing-acceptance-<source SHA>` artifact에 집계 JSON 하나만 저장합니다(7일 보관). 보고서의 mode와 lease가 PR의 합성 가속 lab 결과와 실제 시간 검증을 구분합니다. 소스 SHA, 합성 이미지 digest, 경과 시간, 요청 수/오류/지연, drain 결과를 담고 세션·비밀값·고객 내용·DB·전체 journal은 업로드하지 않습니다. 실패나 취소는 성공 보고서를 만들지 않습니다.

## 남는 운영 경계

컨테이너 정지/재시작은 **OS 재부팅이 아닙니다**. CI 프로세스 사망은 실제 AWS SSM 연결 중단이 아닙니다. 실제 host boot ordering, systemd 자동 복구, SSM 실행 중단·명령 결과 유실, 실제 원본 서비스의 장기 로그인, 모든 Z01–Z09 조합은 운영 준비 환경에서 별도 확인해야 합니다. 두 fixture는 현재 소스에 합성 revision을 부여하므로 서로 다른 소스 버전의 호환성 증거는 기존 브라우저 검사와 구분합니다. 백업·복원의 실운영 검증은 별도입니다.
