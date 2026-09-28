## 1. 적절히 요약한 글

코드 검토와 CI 자동 검사 최적화, 기존 PR 정리와 브랜치 관리 규칙 반영은 끝났습니다. 이번 AWS 기초 자원 생성과 접속 확인은 관리자 측에서 마쳤습니다. 기존 작업자/SUMZ711과 에이전트는 사용 중인 AWS 계정·CLI로 서버를 확인한 뒤 아래 세 가지 남은 작업을 이어가 주세요. 접근 문제가 있으면 관리자 측과 조율해 주세요.

AWS 서버와 접속 준비는 완료됐지만, Marketing 웹 서비스는 아직 배포되지 않았습니다. 2026-09-23에는 `t3a.small` 변경안이 미실행이었으나, 2026-09-28 관리자 측이 전용 foundation과 호스트 기초 자원을 생성하고 SSM으로 신규 서버에 실제 접속했습니다. 웹 서비스 최초 설치·실제 자료 이전·2 GiB 실측은 여전히 남았습니다. 서버 접속 성공을 웹 서비스 배포 완료나 재부팅 복구 검증으로 해석하지 마세요.

- **P1 — 첫 설치:** 전용 서버 기초 자원은 생성됐습니다. 기존 작업자와 에이전트는 Marketing 웹 서비스의 실행 절차를 확인하고 이미지 게시·실서버 최초 설치를 이어가 주세요.
- **P1 — 실제 자료와 로그인:** 실제 DB·업로드·수집기 위치를 찾아 일관 백업과 복원을 수행하고 기존 계정으로 로그인해 주세요. 확인한 두 checkout에서 원본 DB를 찾지 못했다는 사실은 데이터가 0건이라는 뜻이 아닙니다.
- **P2 — 작은 서버의 실제 용량:** 웹 두 개와 실제 수집기가 겹치는 대표 상황을 실서버에서 한 번 측정해 주세요. 현재의 메모리 상한과 합성 CI 결과만으로 2 GiB 운영 가능성을 확정하지 않습니다.

운영 공개와 WARP 자동 전송은 위 증거를 확인한 뒤에만 판정합니다. 이 PR은 남은 작업을 전달하는 문서이며, 실제 배포 완료 보고는 아닙니다.

## 2. 에이전트에게 전할 상세 작업 지시

기존 작업자와 에이전트는 사용 중인 AWS 인증과 CLI로 준비된 서버를 확인한 뒤 최신 웹 서비스 소스·기존 실행 환경·실제 자료의 출처를 확인하고 최초 설치, 자료 이전, 용량 실측을 이어가 주세요. 이번 관리자 측 수행 범위는 AWS 기초 자원 생성과 SSM 접속 검증입니다. 필요한 접근 문제가 생기면 관리자 측과 조율하고, 코드 변경은 검토 가능한 PR로 전달해 주세요. 이미 끝난 CI 최적화·PR 정리·브랜치 정책을 다시 구현하지 말고 필요한 영향 범위만 검사해 과검사와 중복 구현을 피하세요. 자격증명을 PR이나 메신저에 평문으로 공유하지 마세요.

2026-09-23 검토 기준 원격 `main`은 `f1a43b0badaa2dd274f8dd598eff7380f4ce381c`이며, [Linux CI 35814681603](https://github.com/EVNSolution/EVN-MARKETING/actions/runs/35814681603)이 성공한 소스 tree와 같습니다. 소스 검토에서 새 배포 차단 코드 결함은 발견되지 않았습니다.

**1. 검토된 `t3a.small` foundation과 최초 설치**

2026-09-23 검토 대상은 서울 Marketing 전용 `t3a.small`(2 vCPU/2 GiB), 암호화 gp3 40 GiB였고 `foundation-small-20260923` 변경안은 당시 미실행이었습니다. 2026-09-28 확인 결과 `evn-marketing-foundation`은 `CREATE_COMPLETE`(6개 자원), `evn-marketing-host`도 `CREATE_COMPLETE`(4개 자원)입니다. 인스턴스 `i-09022af4acd464470`은 `running`·`t3a.small`·Ubuntu 24.04 x86_64이며, 암호화 gp3 루트 40 GiB, standard CPU, IMDSv2, SSH 22번 포트 닫힘을 확인했습니다. EIP는 `54.180.203.57`입니다. WARP 서버와 자원을 공유하거나 기존 WARP 인프라를 변경하지 마세요. 구 `foundation-20260923`은 `t3.medium`용이므로 사용하지 마세요. [foundation 선언](https://github.com/EVNSolution/EVN-MARKETING/blob/f1a43b0badaa2dd274f8dd598eff7380f4ce381c/deploy/aws/foundation.json), [현재 배포 절차](https://github.com/EVNSolution/EVN-MARKETING/blob/f1a43b0badaa2dd274f8dd598eff7380f4ce381c/docs/cloud-release.md)

2026-09-28 기준 호스트 역할 `EVN-Marketing-Host`와 인스턴스 프로필 `arn:aws:iam::902837199612:instance-profile/evn-marketing-host-HostProfile-LQRB7Mv1EIJ7`이 생성·연결됐습니다. 14:09 KST에 EC2는 `running`, system/instance 상태는 모두 `ok`, SSM은 `Online`(agent 3.3.4793.0)이었습니다. AWS CLI와 Session Manager로 실제 접속해 Linux/x86_64, `ssm-user`, Python 3.12.3 및 무부하 메모리·디스크를 읽고 정상 종료한 세션의 `Terminated` 상태를 확인했습니다. 초기 권한 연결 전 credential failure가 있어 앱 없는 신규 호스트를 한 번 재부팅한 뒤 접속했으며, 이는 앱 재부팅 복구 검증이 아닙니다. ECR 저장소 `evn-marketing`은 `IMMUTABLE`·scan-on-push 활성 상태이나 이미지가 0개입니다. SSM release 문서는 Active 버전 1, hash `205acdd30085715a7276d774938d3cda7d6c61f49fc071b5631af44d9c6585c2`입니다. ECR은 실행 이미지를 보관하는 곳이고 SSM은 서버 관리와 비밀값 보관 경로입니다. GitHub release 역할은 없으며 `EnableGitHubRelease=false`와 관리자 AWS 직접 경로를 유지합니다. [Marketing cloud 선언](https://github.com/EVNSolution/EVN-MARKETING/blob/f1a43b0badaa2dd274f8dd598eff7380f4ce381c/deploy/aws/cloudformation.json)

최신 소스 SHA, 실행 절차, 웹 서비스 설정·상태·초기 journal(서버가 현재 실행 버전을 기억하는 기록)에 필요한 사항을 확인하고, 코드 변경이 필요하면 검토 가능한 PR로 제시하세요. 운영 서버 밖의 Linux amd64 환경에서 같은 소스의 runtime·operations 이미지를 게시하고 두 digest와 ECR 검사 완료 및 기존 취약점 기준 통과를 확인하세요. 2026-09-23 검토 당시 로컬 Docker는 작동했지만 aarch64였으므로 그 빌드만으로 amd64 게시를 증명하지 못합니다. 원격 Docker·controller·Marketing 웹 서비스 설치, 비밀값 설정, 이미지 게시, DNS/TLS, DB·전송 이관은 아직 수행되지 않았습니다. 호스트 도구, TLS/HTTPS 인증서, 고정 config·state와 systemd를 준비해야 합니다. `manual-dispatch`는 새 서버 bootstrap 도구가 아닙니다. 유효한 실제 DB·백업·active journal이 갖춰지기 전에 이 명령으로 첫 설치를 우회하지 마세요. [호스트 설치 선결조건](https://github.com/EVNSolution/EVN-MARKETING/blob/f1a43b0badaa2dd274f8dd598eff7380f4ce381c/docs/cloud-release.md#L71-L76), [컨트롤러](https://github.com/EVNSolution/EVN-MARKETING/blob/f1a43b0badaa2dd274f8dd598eff7380f4ce381c/deploy/controller.py), [설정 예시](https://github.com/EVNSolution/EVN-MARKETING/blob/f1a43b0badaa2dd274f8dd598eff7380f4ce381c/deploy/config.example.json)

이후 일반 배포는 **그 시점의 최신 원격 `main`과 정확히 같은 HEAD의 새 clean checkout**에서 실행합니다. 이전 검증에 사용한 작업공간(HEAD `65e8…`)은 소스 tree가 같아도 미추적 `.omx/` 파일이 있어 helper의 정확한 HEAD·clean 조건을 통과하지 못합니다. 해당 폴더를 그대로 dispatch하지 마세요. [release source guard](https://github.com/EVNSolution/EVN-MARKETING/blob/f1a43b0badaa2dd274f8dd598eff7380f4ce381c/deploy/aws/release.py#L108-L115)

**2. 기존 실제 자료의 출처 확인과 안전한 이전**

실제 DB·업로드, 현재 수집기·웹 실행 위치, 자동 재시작 경로, 비밀값의 이름과 기존 주입 위치를 먼저 특정하세요. 비밀값은 기존 보안 경로만 사용하고 PR 본문·소스·로그·메신저에 비밀값이나 개인정보를 적지 마세요. 이번 검토에서 지정한 두 checkout에 env/source DB가 보이지 않았을 뿐, 다른 위치의 자료가 없다고 결론내리지 않았습니다. 출처를 확인하지 못하면 빈 DB나 seed로 임의 대체하지 말고 해당 항목을 미완료로 남기세요. [기존 이전 순서](https://github.com/EVNSolution/EVN-MARKETING/blob/f1a43b0badaa2dd274f8dd598eff7380f4ce381c/docs/dedicated-server-plan.md#L76-L87)

실제 원본 중지와 데이터 동결은 서버 이관 시점을 정해 진행하며 지금 미리 중지하지 마세요. 그때 모든 기존 writer·수집기와 자동 재시작의 중지를 확인하고, SQLite backup API로 DB 전체와 같은 시점의 업로드 파일을 일관되게 백업하세요. 테이블 건수, migration·문의·전송 receipt·수집 cutoff, 파일 경로·크기·checksum의 익명화된 검증 요약을 남기고 상세 manifest는 비공개로 대조하세요. 암호화된 별도 볼륨에 복원해 DB 무결성, 참조, 파일 내용과 이전 결과를 확인하세요. 기존 계정을 seed로 덮어쓰지 말고 약한 공용 seed 계정도 점검하세요. [백업·복원 절차](https://github.com/EVNSolution/EVN-MARKETING/blob/f1a43b0badaa2dd274f8dd598eff7380f4ce381c/docs/backup-recovery.md)

실제 자료와 게시한 이미지를 확인한 뒤 initial active journal을 구성하고 수집·전송을 끈 웹을 시작하세요. 기존 계정의 HTTPS 로그인, 권한 있는 파일 접근, 복원본 일치를 검증하고, 이어 전송을 끈 단일 실제 수집기로 원본 로그인과 신규 수집을 확인하세요. WARP 자동 전송은 기존 check/pilot 범위가 통과한 뒤 별도로 활성화하며 이 handoff 때문에 추가 대외 메시지나 WARP 자원 변경을 하지 마세요. [컨트롤러 데이터 선결조건](https://github.com/EVNSolution/EVN-MARKETING/blob/f1a43b0badaa2dd274f8dd598eff7380f4ce381c/deploy/controller.py#L188-L201)

**3. 2 GiB 대표 부하 한 번 측정**

웹 각각 384 MiB와 worker 768 MiB는 cgroup 상한이며 OS·프록시를 포함한 실측 메모리나 예약량이 아닙니다. 실제 최초 전체 수집과 active/candidate 웹 두 개가 겹치는 상황을 실서버에서 한 번 재현해 OOM 0, 지속 swap 0, 호스트 여유와 처리시간을 기록하세요. 실패하면 기존 웹을 억지로 먼저 종료해 통과시키거나 승인 없이 4 GiB `medium`으로 바꾸지 마세요. 측정값과 최소 보완안을 보고하세요. 출시 전 7일 대기, 매번 실제 30분 CI, 전체 CI 반복을 새 조건으로 추가하지 마세요. [서버 측정 기준](https://github.com/EVNSolution/EVN-MARKETING/blob/f1a43b0badaa2dd274f8dd598eff7380f4ce381c/docs/dedicated-server-plan.md#L101-L113)

완료 보고는 세 항목을 분리하세요. 첫 설치의 실제 main SHA·runtime/operations digest·대상 서버/SSM/HTTPS 정상 상태, 자료 이전의 일관 백업·개인정보 없는 검증 요약·별도 복원 동일성·기존 계정 로그인, 2 GiB 용량의 대표 부하 OOM·swap·여유·처리시간과 남은 제약을 제시하세요. 필요한 비밀값의 이름과 기존 주입 위치만 기록하고 값 자체는 기존 보안 경로로 취급하세요. 확인된 범위만 완료로 표시하고 한 단계의 성공을 운영 전체 완료로 확대하지 마세요.
