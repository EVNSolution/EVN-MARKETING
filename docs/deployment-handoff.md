## 1. 요약

관리자 측에서 Marketing 전용 서버의 도메인 연결, Caddy HTTPS와 인증서 발급, 프록시 연결 검증을 마쳤습니다. [서비스 주소](https://marketing.cleversystem.ai)는 현재 웹 앱이 설치되지 않아 `503 서비스 준비 중`을 표시합니다. 서버 접속 준비와 웹 서비스 배포 완료를 구분해 주세요.

이미지 보관소(ECR)에 게시된 이미지는 있지만 보안 검사를 통과하지 못해 웹 앱 실행을 시작하지 않았습니다. PR #19는 `main`에 병합됐고 중복 PR #17·#18과 해당 원격 브랜치는 정리됐습니다. 이 문서는 작업 인계이며 운영 공개 승인이나 배포 완료 보고가 아닙니다.

SUMZ711과 작업 에이전트께서는 기존 AWS 계정·CLI로 서버를 확인하고 **① 안전한 이미지 마련, 실제 자료 복원과 웹 최초 실행, ② 기존 계정 로그인과 단일 수집·WARP 검증, ③ 2 GiB 서버의 대표 부하 측정**을 이어가 주세요. 확인된 결과만 완료로 보고해 주세요.

## 2. 에이전트에게 전할 상세 작업

**시작 기준과 역할.** 현재 검토 기준은 2026-09-29입니다. [PR #19](https://github.com/EVNSolution/EVN-MARKETING/pull/19)의 소스·CI 검토에서는 추가 수정이 필요한 확정 기능 코드 결함을 찾지 못했지만, 이것이 이미지 보안 검사 통과나 운영 배포를 뜻하지는 않습니다. PR #19 병합 후 `main`은 `6987e16c2e3342910c7e2c1b4a10915308aa0e40`이며 검토한 PR #19와 소스 tree가 같습니다. 실제 배포 시에는 그때 최신 원격 `main`과 HEAD가 정확히 같은 새 clean checkout만 사용해 주세요. 기존 `manual-dispatch`는 새 호스트의 첫 설치를 대신하지 않습니다. 변경이 필요하면 검토 가능한 PR로 전달하고, 자격증명·개인정보·SecureString 값은 PR·로그·메신저에 적지 마세요. [배포 문서](https://github.com/EVNSolution/EVN-MARKETING/blob/6987e16c2e3342910c7e2c1b4a10915308aa0e40/docs/cloud-release.md), [release guard](https://github.com/EVNSolution/EVN-MARKETING/blob/6987e16c2e3342910c7e2c1b4a10915308aa0e40/deploy/aws/release.py).

**준비된 서버와 HTTPS를 확인하세요.** Route 53 A 레코드는 `54.180.203.57`(TTL 300)로 `INSYNC`입니다. 기존 AWS 인증을 사용하는 CLI에서 다음 읽기 조회로 계정과 인스턴스·SSM 상태를 먼저 확인하세요. 대상은 서울 `ap-northeast-2`의 `i-09022af4acd464470`(`t3a.small`, 2 GiB), 예상 계정은 `902837199612`입니다. 계정이 다르거나 접근 오류가 나면 이어서 접속하지 말고 관리자 측과 기존 접근 경로를 조율하세요.

```bash
aws sts get-caller-identity --query Account --output text
aws ec2 describe-instances --region ap-northeast-2 --instance-ids i-09022af4acd464470 --query 'Reservations[].Instances[].{State:State.Name,Type:InstanceType}' --output table
aws ssm describe-instance-information --region ap-northeast-2 --filters Key=InstanceIds,Values=i-09022af4acd464470 --query 'InstanceInformationList[].{Id:InstanceId,Status:PingStatus}' --output table
```

호스트 Caddy 2.11.4는 `active/enabled`, 기존 host Nginx는 `inactive/disabled`입니다. 관리자 측 외부 확인에서 HTTP→HTTPS `308`, 시스템이 신뢰하는 Let's Encrypt 인증서(SAN `marketing.cleversystem.ai`, TLS 1.3)의 HTTPS HTTP/2 `503 서비스 준비 중`을 확인했습니다. Caddy 서비스는 reload 뒤에도 유지됐고, 단발성 루프백 진단으로 프록시 HTTPS `204` 및 Host/forwarded 헤더 전달을 확인했습니다. 진단 프로세스 종료 후 3080 리스너가 없는 상태와 공개 HTTPS 503 복귀도 확인했습니다. 기존 AWS 계정으로 접속해 `systemctl is-active caddy`, `systemctl is-enabled caddy`, `journalctl -u caddy --no-pager`를 확인하고, 외부에서 `curl -I http://marketing.cleversystem.ai/`, `curl -I https://marketing.cleversystem.ai/`로 상태를 다시 확인해 주세요. Caddy 재설치는 현재 작업에 필요하지 않고 인증서 자동 갱신은 구성됐습니다. 공개 포트는 80/443뿐이고 내부 `127.0.0.1:3080`은 외부로 열지 마세요. 현재 호스트 Caddy 설정의 SHA-256은 `9dd6c5873ebab3c5b743f900a55a8ed30c9bbcfabc98a9854b9d8b256882e8cd`이며 내용은 아래와 같습니다. `reverse_proxy` 뒤의 Nginx는 Docker 안쪽 서비스입니다.

```caddyfile
marketing.cleversystem.ai {
	reverse_proxy 127.0.0.1:3080

	handle_errors 502 {
		respond "서비스 준비 중" 503
	}
}
```

**1. 이미지 보완과 웹 서비스 최초 설치.** 현 runtime digest `sha256:5d8ad2c79b670af171d522dc1d2d6d458335bd364e63fcb567da802cae0c52ab`는 High 10, operations `sha256:8224a35aa6e597893efca64cb27a1fb9fba9f028c3364a4d5371c3596fb349dc`는 High 2로 PR #19의 `scan_clean()`을 통과하지 못했습니다. 이 이미지들은 병합 전 PR head `c3c9e443…` 기준 게시물이므로 tree가 같더라도 새 `main` SHA의 이미지 증거가 아닙니다. Debian 공식 기록의 [libxml2](https://security-tracker.debian.org/tracker/CVE-2026-86139), [expat](https://security-tracker.debian.org/tracker/CVE-2026-93990), [perl](https://security-tracker.debian.org/tracker/CVE-2026-82560), [zlib](https://security-tracker.debian.org/tracker/CVE-2026-85091) 상태와 실제 이미지 audit 결과를 구분합니다. 정확한 amd64 이미지 감사에서 Pod::Text는 양쪽에, Python libxml2 바인딩은 runtime에 없었지만 Chromium은 libexpat·zlib·libgbm을 실제 로드하며 libxml2도 설치 의존 사슬에 있습니다. 이 사실은 High 전체 해결이나 삭제 안전성의 증거가 아닙니다. 새 이미지 빌드·게시·패키지 변경은 아직 없으며 보안 예외도 승인되지 않았습니다. 지원되는 stable 수정이나 검증된 이미지 보완을 검토하되, 무작정 패키지를 삭제하거나 검사를 완화하지 마세요. 최신 `main`에서 Linux amd64 runtime·operations 이미지를 만들고 각각 새 digest, ECR 검사 완료 및 기존 기준 통과, 필요한 Chromium/SQLite 회귀를 확인해 주세요. [이미지·호스트 절차](https://github.com/EVNSolution/EVN-MARKETING/blob/6987e16c2e3342910c7e2c1b4a10915308aa0e40/docs/cloud-release.md).

호스트에는 Docker·AWS CLI·SSM·ECR 로그인 헬퍼와 네 비밀값 항목의 메타데이터가 이미 확인됐습니다(값은 읽지 않음). 현재 상태를 다시 확인한 뒤 controller·고정 config/state·systemd와 Docker 내부 Nginx의 blue/green 연결을 루프백 3080 뒤에 준비하세요. 실제 DB 복원과 두 이미지 digest·스캔을 검증한 뒤 PR #19에 추가된 [controller bootstrap](https://github.com/EVNSolution/EVN-MARKETING/blob/6987e16c2e3342910c7e2c1b4a10915308aa0e40/deploy/controller.py)으로 초기 active journal(현재 실행 버전 기록)을 수집·전송 off 상태에서 구성하세요. `manual-dispatch`로 첫 설치를 우회하지 마세요. 웹이 HTTPS에서 실제 나타나는지 따로 검증하고, 비밀값은 기존 보안 경로로만 주입하며 값을 보고서에 남기지 마세요.

**2. 실제 자료와 기존 로그인.** 실제 원본 DB·업로드·수집기 위치와 자동 재시작 경로를 먼저 특정하세요. 두 작업공간에서 원본 DB를 찾지 못했다는 이전 기록은 데이터가 0건이라는 뜻이 아닙니다. 출처를 못 찾으면 빈 DB나 seed로 대체하지 마세요. 이관 시점을 협의하기 전에는 기존 수집기를 미리 중지하지 않습니다. 전환 시 모든 기존 writer·수집기 및 자동 재시작을 멈춘 것을 확인한 뒤 SQLite backup API와 같은 시점의 업로드를 보관하고, 건수·ID·receipt·파일 checksum·cutoff를 익명 요약과 비공개 manifest로 대조하세요. 암호화된 별도 볼륨에 복원해 무결성·파일·기존 계정 HTTPS 로그인까지 검증하고, 기존 계정을 seed로 덮어쓰지 마세요. SUMZ711 보고의 `409/406/3`과 실제 원본·복원 결과를 구분해 기록하세요. [이전 순서](https://github.com/EVNSolution/EVN-MARKETING/blob/6987e16c2e3342910c7e2c1b4a10915308aa0e40/docs/dedicated-server-plan.md#L76-L87), [복원](https://github.com/EVNSolution/EVN-MARKETING/blob/6987e16c2e3342910c7e2c1b4a10915308aa0e40/docs/backup-recovery.md).

**3. 단일 수집기·WARP·2 GiB 실측.** 복원과 기존 로그인 이후 전송을 끈 단일 실제 수집기로 원본 로그인·신규 수집을 확인하고, WARP 전송은 기존 check/pilot 범위 검증 후 별도 활성화하세요. WARP 서버 설정을 이 PR에서 바꾸지 마세요. 웹 각 384 MiB와 worker 768 MiB는 컨테이너 상한이지 OS 포함 실사용량이 아닙니다. 실제 수집과 웹 두 개가 겹치는 대표 상황을 한 번 측정해 OOM 0, 지속 swap 0, 호스트 여유·처리시간을 기록하세요. 실패 시 수치를 보고하고 최소 보완안을 검토하며 무단으로 4 GiB 인스턴스로 바꾸지 마세요. [측정 기준](https://github.com/EVNSolution/EVN-MARKETING/blob/6987e16c2e3342910c7e2c1b4a10915308aa0e40/docs/dedicated-server-plan.md#L101-L113).

완료 보고는 **(1) 정확한 최종 main SHA와 두 새 digest·스캔 및 실제 HTTPS 웹 상태, (2) 익명화된 원본·백업·복원 동일성 및 기존 계정 로그인, (3) 단일 수집·WARP 확인과 2 GiB 측정값**으로 나누어 주세요. 필요한 영향 범위 검사만 수행하고, 이미 끝난 CI 최적화·PR 정리의 재구현이나 반복 전체 CI, 7일 대기, 매번 30분 관측을 새 선결조건으로 만들지 마세요.
