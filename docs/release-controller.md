# 배포·복귀 컨트롤러

M3의 호스트 실행 코드입니다. [전체 인수 기준](zero-downtime-deployment-plan.md#7-필수-인수-검사)은 유지하며, 이 구현만으로 M3 전체나 운영 배포 완료를 선언하지 않습니다. AWS 자원 생성, 실제 고객 DB 접근, 기존 서비스 배포는 수행하지 않습니다.

## 고정 실행 경계

`deploy/controller.py`는 Python 표준 라이브러리와 Docker CLI를 사용합니다. 호스트 경로는 `/opt/evn-marketing-runtime`, 설정은 `config.json` 하나이며 예시는 `deploy/config.example.json`입니다. 이미지 revision은 40자리 SHA, image digest는 실제 RepoDigest와 대조합니다. 운영은 amd64 전용입니다.

- 컨테이너: `evn-marketing-web-blue`, `evn-marketing-web-green`, `evn-marketing-worker`, `evn-marketing-proxy`.
- 공유 데이터: `evn-marketing-data` Docker local volume. bootstrap에서 암호화 EBS에 Docker 데이터 위치와 볼륨을 고정해야 합니다. volume 이름만으로 EBS 배치를 증명하지 않습니다.
- 네트워크: `evn-marketing`. 웹 포트는 호스트 loopback 3100/3101에만 노출합니다. 별도 TLS 앞단만 공개하며 내부 프록시는 공개하지 않습니다.
- 작업 잠금: `state/host.lock`의 동일 inode에 비차단 `flock`. 후속 backup/migration도 이 잠금을 공유해야 합니다. 경쟁 실행은 변경 없이 exit 75입니다.
- 상태: `state/release.json`에 현재/직전/후보 SHA·digest·slot·worker owner와 phase를 저장합니다. 임시 파일 fsync → atomic rename → 디렉터리 fsync로 교체합니다.

관리자가 검토한 코드·설정·초기 journal·프록시·볼륨이 준비되어 있어야 합니다. 이 도구는 누락된 초기 상태를 추측해 만들지 않습니다. SSM의 설치 코드 checksum, 운영 environment와 최소 권한은 [AWS 배포 연결](cloud-release.md)을 따릅니다.

## 전환과 복구

1. 기존 웹/worker 상태, 최근 24시간 내 완료된 암호화 snapshot 및 복원 검증 기록, 디스크/메모리 여유, 실제 schema와 두 이미지 호환성을 확인합니다. 백업 기록 생성은 M4의 별도 일관된 백업 절차입니다.
2. `preparing`: inactive 웹을 시작하고 실제 Image ID·RepoDigest·volume과 readiness를 확인합니다. 기존 웹과 worker는 유지합니다.
3. `draining`: 기존 worker의 작업 허용 파일을 제거하고 TERM을 전달합니다. 180초 안의 정상 종료·프로세스 부재·lease 해제를 모두 확인합니다. 강제 종료로 다음 worker를 허용하지 않습니다.
4. `switching`: Nginx 후보 설정 검사 후 atomic 교체/reload로 기본 요청을 새 웹에 연결합니다. 이전 탭의 등록된 버전은 직전 웹으로 연결합니다. 공개 HTTPS의 인증서와 응답 identity를 확인합니다.
5. `starting`: 새 worker는 원본 로그인과 lease/health 확인 전까지 새 수집·WARP 전송을 실행하지 않습니다. 확인 후 해당 owner의 허용 파일만 생성합니다. 기존 예약 시각은 보존합니다.
6. `observing`: 30분 동안 공개 readiness를 1초 간격으로 확인하고 worker 상태도 반복 확인합니다. 관측 시간은 monotonic clock으로도 보장하여 시계가 앞으로 이동해 단축되지 않게 합니다. 실제 프로브/명령 처리 시간만큼 간격이 늘 수 있습니다.
7. `stable` → `retiring`: 새 버전을 commit하고 이전 버전 매핑을 만료시킵니다. reload 전 Nginx worker가 모두 종료된 것을 확인해야 이전 슬롯을 재사용합니다. 180초 내 drain이 끝나지 않으면 재사용을 차단합니다. 이전 이미지는 코드 rollback 대상으로 보존합니다.

전환 전 준비 실패는 기존 worker를 유지하고 후보를 정리합니다. 기존 worker 종료 이후의 실패는 실제 실행 중인 알려진 worker를 정지·검증하고, 이전 웹/worker 조합으로 복귀합니다. **DB·업로드·receipt는 되돌리지 않습니다.** 불명확한 컨테이너, 미해제 lease, schema 불일치 등으로 복귀를 확인할 수 없으면 `blocked`를 남깁니다.

`rollback`은 저장된 직전 release만 대상으로 위의 동일한 gate와 전환을 거칩니다. 임의 digest·DB 복원 인자를 받지 않습니다. 중단된 journal의 `recover`는 origin으로 복귀하며 candidate를 자동 승격하지 않습니다. 안정 상태에서 재부팅되면 기록된 active만 재시작하고 실제 프로세스 부재 뒤 만료 lease를 기다립니다. DB lease를 강제로 지우지 않습니다.

`deploy/marketing-recover.service`는 부팅 복구, `marketing-release.service`와 `.timer`는 만료 확인 선언입니다. 설치/활성화하지 않았습니다. TLS 앞단의 시작 순서는 실제 bootstrap에서 맞춰야 합니다. SSM 연결/CI 응답이 끊겼을 때는 journal·실제 컨테이너·명령 상태부터 확인하며 무조건 다시 배포하지 않습니다.

## 비밀값과 수집기

비밀값은 호스트 역할이 지정된 Marketing SecureString에서 받아 메모리로만 처리합니다. Docker 인자에는 환경변수 이름만 전달하고 값은 env 파일·journal·출력에 남기지 않습니다. Docker 실행 환경은 호스트 관리자에게 조회 가능하므로 호스트/Docker 권한은 운영 관리자만 가집니다. 웹에는 AUTH_SECRET, worker에는 필요한 원본/WARP 키를 주입합니다.

수집기 작업 허용은 `/app/worker-activation.version` 값 `1`인 두 이미지에서만 지원합니다. 이 파일이 없는 이전 이미지에서 바로 자동 전환할 수 없습니다. 최초 운영 bootstrap은 이 기능이 포함된 검토 버전으로 별도 수행해야 합니다. 로컬 실행에서 작업 허용 경로가 없으면 기존 동작을 유지합니다. 운영의 수집/전송 활성화는 이관 및 파일럿 이후에 진행합니다.

## 검사와 남은 증거

```text
python3 tests/deploy-controller.test.py
python3 tests/cloud-release.test.py
npm run test:worker-runtime
npm run test:release-routing
```

컨트롤러 단위 검사는 상태 전이·실패 복귀·잠금 경쟁·atomic 기록 실패·snapshot 조건과 출력의 비밀값 비노출을 검사합니다. AWS 선언 검사는 합성 응답과 고정 SSM 프로그램을 사용합니다. 실제 AWS 권한이나 자원 동작을 증명하지 않습니다.

CI의 `tests/deploy-controller-lab.py`는 외부 통신이 차단된 Docker 네트워크에서 실제 Nginx·TLS·SQLite·RepoDigest를 사용합니다. 현재 이미지로 만든 두 합성 revision과 합성 worker로 A→B→A, 전환 중 지속 HTTPS probe, 이전 매핑 만료/drain, 새 worker 준비 실패 후 복귀, 최신 데이터 보존을 검사합니다. 기본 관측 clock은 가속합니다. 실제 서로 다른 소스 버전의 브라우저·동시 업로드 검사는 기존 `tests/release-compat.sh`가 별도로 유지합니다.

추가한 실제 시간·요청 drain·프로세스 중단 검사의 실행 방법과 증거 경계는 [배포 인수 검사](release-acceptance.md)를 따릅니다. 실제 호스트 재부팅·SSM 중단 복구, 전체 Z01–Z09 조합 검사, M4 일관된 backup/restore·receipt 리허설 및 용량 측정은 별도 gate입니다. AWS bootstrap과 운영 공개는 이 증거와 운영 환경 구성이 마련된 다음 단계입니다.
