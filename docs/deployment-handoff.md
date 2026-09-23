## 1. 적절히 요약한 글

코드 검토와 CI 자동 검사 최적화, 기존 PR 정리와 브랜치 관리 규칙 반영은 끝났습니다. 기존 작업자께서는 아래 세 가지 운영 준비만 이어서 마무리해 주세요.

전용 서버를 만들 `t3a.small` 변경안은 검토가 끝났지만 아직 실행하지 않았습니다. 따라서 서버가 생겼거나 서비스가 배포된 상태는 아닙니다. 남은 작업은 전용 서버의 첫 설치, 기존 실제 자료와 계정의 안전한 이전, 2 GiB 서버에서 실제 수집과 두 웹이 함께 작동하는지 확인하는 세 가지입니다.

- **P1 — 첫 설치:** 서울의 Marketing 전용 서버와 배포 기반을 만들고 최초 실행 상태를 준비합니다.
- **P1 — 실제 자료와 로그인:** 기존 작업자가 알고 있는 실제 DB·업로드·수집기 위치를 찾아, 자료와 전송 이력을 보존하며 이전하고 기존 계정으로 로그인합니다. 확인한 두 checkout에서 원본 DB를 찾지 못했다는 사실은 데이터가 0건이라는 뜻이 아닙니다.
- **P2 — 작은 서버의 실제 용량:** 웹 두 개와 실제 수집기가 겹치는 대표 상황을 한 번 측정합니다. 현재의 메모리 상한과 합성 CI 결과만으로 2 GiB 운영 가능성을 확정하지 않습니다.

운영 공개와 WARP 자동 전송은 위 증거를 확인한 뒤에만 판정합니다. 이 PR은 남은 작업을 전달하는 문서이며, 실제 배포 완료 보고는 아닙니다.

## 2. 에이전트에게 전할 상세 작업 지시

다음 범위만 이어서 수행해 주세요. 이미 끝난 CI 최적화·PR 정리·브랜치 정책을 다시 구현하지 마시고, 필요한 영향 범위의 검사만 실행해 과검사와 중복 구현을 피하세요.

2026-09-23 검토 기준 원격 `main`은 `f1a43b0badaa2dd274f8dd598eff7380f4ce381c`이며, [Linux CI 35814681603](https://github.com/EVNSolution/EVN-MARKETING/actions/runs/35814681603)이 성공한 소스 tree와 같습니다. 소스 검토에서 새 배포 차단 코드 결함은 발견되지 않았습니다.

**1. 검토된 `t3a.small` foundation과 최초 설치**

현재 검토 기록의 대상은 서울 Marketing 전용 `t3a.small`(2 vCPU/2 GiB), 암호화 gp3 40 GiB입니다. WARP 서버와 자원을 공유하거나 기존 WARP 인프라를 변경하지 마세요. `evn-marketing-foundation`의 `foundation-small-20260923`은 미실행 `AVAILABLE` CREATE 변경안으로, 6개 추가·현재 실제 자원 0개입니다. 로컬·원격 템플릿은 일치하고 EIP 한도 8개 증액이 적용됐습니다. 기존 `foundation-20260923`은 `t3.medium`용이므로 사용하지 마세요. 이는 검토 시점의 상태이므로 착수 직전에 정확한 변경안·계정·리전·대상과 필요한 용량만 다시 확인하세요. [foundation 선언](https://github.com/EVNSolution/EVN-MARKETING/blob/f1a43b0badaa2dd274f8dd598eff7380f4ce381c/deploy/aws/foundation.json), [현재 배포 절차](https://github.com/EVNSolution/EVN-MARKETING/blob/f1a43b0badaa2dd274f8dd598eff7380f4ce381c/docs/cloud-release.md)

검토 당시 Marketing EC2·ECR 저장소·host IAM·SSM 파라미터 메타데이터가 없었고 `marketing.cleversystem.ai`는 `NXDOMAIN`이었습니다. 생성된 서버와 암호화 디스크의 실제 식별자·상태를 확인한 뒤 Marketing 전용 권한, ECR 이미지 저장소, SSM 관리·비밀값 경로를 준비하세요. ECR은 실행 이미지를 보관하는 곳이고 SSM은 서버 관리와 비밀값 보관 경로입니다. GitHub 배포 역할은 `EnableGitHubRelease=false`로 두고 관리자 AWS 직접 경로를 유지하세요. [Marketing cloud 선언](https://github.com/EVNSolution/EVN-MARKETING/blob/f1a43b0badaa2dd274f8dd598eff7380f4ce381c/deploy/aws/cloudformation.json)

운영 서버 밖의 Linux amd64 빌드 환경에서 같은 소스의 runtime·operations 이미지를 만들고, 두 실제 digest와 ECR 검사가 완료되고 기존 취약점 기준을 통과했는지 확인하세요. 현재 로컬 Docker는 작동하지만 aarch64이므로 그 빌드만으로 amd64 게시를 증명하지 못합니다. 호스트 도구, SSM 접속, TLS/HTTPS 인증서, 고정 config·state와 systemd를 준비하세요. 초기 journal은 첫 사용 때 서버가 현재 실행 버전을 기억하도록 만드는 기록입니다. `manual-dispatch`는 새 서버 bootstrap 도구가 아닙니다. 유효한 실제 DB·백업·active journal이 갖춰지기 전에 이 명령으로 첫 설치를 우회하지 마세요. [호스트 설치 선결조건](https://github.com/EVNSolution/EVN-MARKETING/blob/f1a43b0badaa2dd274f8dd598eff7380f4ce381c/docs/cloud-release.md#L71-L76), [컨트롤러](https://github.com/EVNSolution/EVN-MARKETING/blob/f1a43b0badaa2dd274f8dd598eff7380f4ce381c/deploy/controller.py), [설정 예시](https://github.com/EVNSolution/EVN-MARKETING/blob/f1a43b0badaa2dd274f8dd598eff7380f4ce381c/deploy/config.example.json)

이후 일반 배포는 **그 시점의 최신 원격 `main`과 정확히 같은 HEAD의 새 clean checkout**에서 실행하세요. 이전 검증에 사용한 작업공간(HEAD `65e8…`)은 소스 tree가 같아도 미추적 `.omx/` 파일이 있어 helper의 정확한 HEAD·clean 조건을 통과하지 못합니다. 해당 폴더를 그대로 dispatch하지 마세요. [release source guard](https://github.com/EVNSolution/EVN-MARKETING/blob/f1a43b0badaa2dd274f8dd598eff7380f4ce381c/deploy/aws/release.py#L108-L115)

**2. 기존 실제 자료의 출처 확인과 안전한 이전**

기존 작업자가 알고 있는 실제 DB, 업로드, 현재 수집기·웹 실행 위치, 비밀값 주입 경로를 먼저 특정하세요. 이번 검토에서 지정한 두 checkout에 env/source DB가 보이지 않았을 뿐, 다른 위치의 자료가 없다고 결론내리지 않았습니다. PR 본문, 소스, 로그에 비밀값·개인정보를 적지 마세요. 출처를 확인하지 못하면 빈 DB나 seed로 임의 대체하지 말고 해당 항목을 미완료로 남기세요. [기존 이전 순서](https://github.com/EVNSolution/EVN-MARKETING/blob/f1a43b0badaa2dd274f8dd598eff7380f4ce381c/docs/dedicated-server-plan.md#L76-L87)

실제 전환 시 모든 기존 writer·수집기와 자동 재시작을 중지했는지 확인하세요. SQLite backup API로 DB 전체를 백업하고 같은 시점의 업로드 파일을 함께 묶으세요. 테이블 건수, migration·문의·전송 receipt·수집 cutoff, 파일 경로·크기·checksum을 비공개 manifest로 대조하세요. 암호화된 별도 볼륨에 복원해 DB 무결성, 참조, 파일 내용과 이전 결과를 확인하세요. 기존 계정을 seed로 덮어쓰지 말고 약한 공용 seed 계정도 점검하세요. [백업·복원 절차](https://github.com/EVNSolution/EVN-MARKETING/blob/f1a43b0badaa2dd274f8dd598eff7380f4ce381c/docs/backup-recovery.md)

실제 자료와 게시한 이미지를 확인한 뒤 initial active journal을 구성하세요. 수집·전송을 끈 웹으로 HTTPS 로그인, 권한 있는 파일 접근, 복원본 일치를 확인하세요. 그다음 전송을 끈 단일 실제 수집기로 원본 로그인과 신규 수집을 검증하세요. WARP 자동 전송은 기존 check/pilot 범위가 통과한 뒤 별도로 활성화하며 이 handoff 때문에 추가 대외 메시지나 WARP 자원 변경을 하지 마세요. [컨트롤러 데이터 선결조건](https://github.com/EVNSolution/EVN-MARKETING/blob/f1a43b0badaa2dd274f8dd598eff7380f4ce381c/deploy/controller.py#L188-L201)

**3. 2 GiB 대표 부하 한 번 측정**

웹 각각 384 MiB와 worker 768 MiB는 cgroup 상한이며 OS·프록시를 포함한 실측 메모리나 예약량이 아닙니다. 실제 최초 전체 수집과 active/candidate 웹 두 개가 겹치는 대표 상황을 한 번 재현해 OOM 0, 지속 swap 0, 호스트 여유와 처리시간을 기록하세요. 실패하면 기존 웹을 억지로 먼저 종료해 통과시키거나 승인 없이 4 GiB `medium`으로 바꾸지 마세요. 측정값과 최소 보완안을 보고하세요. 출시 전 7일 대기, 매번 실제 30분 CI, 전체 CI 반복을 새 조건으로 추가하지 마세요. [서버 측정 기준](https://github.com/EVNSolution/EVN-MARKETING/blob/f1a43b0badaa2dd274f8dd598eff7380f4ce381c/docs/dedicated-server-plan.md#L101-L113)

완료 보고에는 세 항목을 분리하세요. 첫 설치는 실제 main SHA·runtime/operations digest·대상 서버/SSM/HTTPS 정상 상태, 데이터 이전은 개인정보 없는 백업·별도 복원 동일성 및 기존 계정 로그인, 2 GiB 용량은 대표 부하의 OOM·swap·여유·처리시간과 남은 제약을 제시하세요. 확인된 범위만 완료로 표시하고, 한 단계의 성공을 운영 전체 완료로 확대하지 마세요.
