## 1. 요약

관리자 측에서 Marketing 전용 서버, 도메인 연결과 HTTPS 접속, 첫 설치에 필요한 호스트의 기본 도구를 준비했습니다. [서비스 주소](https://marketing.cleversystem.ai)는 아직 웹 서비스가 없어 `503 서비스 준비 중`입니다. 이 상태를 배포 완료로 보시면 안 됩니다.

관리자 측에서 새 runtime·operations 이미지를 게시하고 보안 검사와 실제 서버의 합성 검증을 통과시켰습니다. [PR #20](https://github.com/EVNSolution/EVN-MARKETING/pull/20)의 CI도 성공했습니다. **실제 자료로 첫 웹 서비스를 실행한 것은 아닙니다.** 자료 수신용 비공개 S3 버킷과 서버의 설치 준비는 마쳤습니다. 이 작업들을 SUMZ711님께 다시 맡기지 않습니다.

현재 꼭 필요한 협조는 **SUMZ711님 PC에만 있는 실제 Marketing DB와 업로드 파일**입니다. 본인 AWS 계정으로 CLI에 로그인하고 원본 위치를 확인해 주세요. 아래 수신 경로는 사용 가능하지만, 협의한 이관 시점 전에는 기존 수집기를 중지하지 마세요. 그 시점에 일관된 백업을 전달하고, 복원 후 기존 계정 로그인을 함께 확인해 주세요. 추가 인증이 필요하면 본인이 협조해 주세요. 원본은 복원 검증이 끝날 때까지 보존합니다.

## 2. 에이전트에게 전할 상세 작업

**현재 경계.** 2026-09-29 기준 서울 서버 `i-09022af4acd464470`은 `t3a.small`(2 GiB)입니다. 도메인과 Caddy HTTPS 인증서·자동 갱신 구성이 완료됐고 외부 HTTPS는 정상 인증서로 `503 서비스 준비 중`을 반환합니다. 서버의 Docker·AWS CLI·SSM, 비어 있는 Marketing 전용 볼륨, controller 코드·renderer(`0644`)·data-ops 도구·실행 config·비활성 systemd 유닛이 설치됐고 아래 proxy·runtime·operations 이미지는 정확한 digest로 내려받았습니다. 설정의 `volumeId`는 `evn-marketing-production-i-09022af4acd464470`이지만 실제 볼륨 marker는 자료 검증 후 맞춰 준비해야 합니다. **실제 DB·업로드·초기 journal·웹 컨테이너는 아직 없습니다.** 자료 수신용 S3 버킷은 생성됐고, 실제 호스트 권한으로 합성 파일을 받아 체크섬을 대조한 뒤 삭제했습니다. 고객 자료 이관·복원은 하지 않았습니다. [배포 절차](https://github.com/EVNSolution/EVN-MARKETING/blob/7aa6ca187ddffd8d3e1b27524ab72acaf207ac18/docs/cloud-release.md), [controller](https://github.com/EVNSolution/EVN-MARKETING/blob/7aa6ca187ddffd8d3e1b27524ab72acaf207ac18/deploy/controller.py).

**관리자 측 선행 작업.** [PR #20](https://github.com/EVNSolution/EVN-MARKETING/pull/20)이 `main`에 병합됐고 현재 `main`은 `7aa6ca187ddffd8d3e1b27524ab72acaf207ac18`입니다. 같은 SHA의 [CI 실행](https://github.com/EVNSolution/EVN-MARKETING/actions/runs/36507248795)은 컨테이너 smoke, 두 이미지의 브라우저·동시 업로드 검사와 controller lab을 포함해 성공했습니다. Linux amd64 두 이미지는 이 소스 revision으로 아래 digest에 게시됐고 ECR Basic 검사 원문에 기존 [release scan gate](https://github.com/EVNSolution/EVN-MARKETING/blob/7aa6ca187ddffd8d3e1b27524ab72acaf207ac18/deploy/aws/release.py#L53-L71)를 적용해 모두 통과했습니다. 실제 호스트에서도 합성 자료로 컨테이너·브라우저 검증을 통과했습니다. 기존 보안 검사 차단 이미지는 사용하지 않습니다.

ECR 저장소는 `902837199612.dkr.ecr.ap-northeast-2.amazonaws.com/evn-marketing`이며, 아래 `@sha256:` 참조가 실제 게시된 불변 이미지입니다.

| 이미지 | 불변 ECR 참조 | ECR 검사 |
| --- | --- | --- |
| runtime | `902837199612.dkr.ecr.ap-northeast-2.amazonaws.com/evn-marketing@sha256:ce950855b2c9a39e791c19ce689382a7e36de1a0770a6a878ff55aa59ac52182` | 2026-09-29 10:32:37 KST Basic `COMPLETE`, Critical/High/Undefined 0, Medium 4; gate 통과 |
| operations | `902837199612.dkr.ecr.ap-northeast-2.amazonaws.com/evn-marketing@sha256:2bdf0690cf1b544e96d8976b0bce73e4ec2af5bb2164038ea7e030f58a90e6ca` | 2026-09-29 10:35:16 KST Basic `COMPLETE`, Critical/High/Undefined 0, Medium 4; gate 통과 |
| proxy | `902837199612.dkr.ecr.ap-northeast-2.amazonaws.com/evn-marketing@sha256:5c62b1566930f9875c9367e459f0f6474e317be9cde8ba8e5419022133311e14` | 2026-09-29 10:03:32 KST Basic `COMPLETE`, 발견 0; 호스트에 정확한 digest 확인 |

실제 호스트의 합성 검증에서 SQLite·Chromium·패키지 CLI, 합성 계정 브라우저 로그인, 준비도 실패·복구·인증 경계와 웹 두 개·브라우저 동시 실행이 통과했습니다(SSM `af9e8931-14d2-4c05-9885-974d07c2d227`, 49초). OOM·oom_kill은 0이었고 두 웹·브라우저 실행 중 `MemAvailable`은 1,168 MiB였습니다. 다만 test 컨테이너가 768 MiB 상한에 닿았으며, 이는 **실제 수집기나 운영 부하 측정이 아닙니다.** 최종 확인에서 합성 컨테이너와 S3 객체 버전을 제거했고 운영 볼륨은 비어 있으며 config는 변경되지 않았고 journal은 없습니다. operations 이미지도 정확한 digest·Linux/amd64·소스 revision을 호스트에서 확인했습니다(SSM `ccb49d7c-0d79-4caf-9f50-8c993ce5a961`). 외부 HTTPS는 검증된 TLS로 여전히 503을 반환합니다. 원본 수집과 웹 두 개의 대표 부하 검증은 자료 이관 뒤 남습니다.

ECR 검사는 완료 상태와 취약점 정보 갱신 시각이 각각 24시간 이내인지 확인해야 하므로, 첫 실행 직전 정확한 두 digest의 현재 결과를 다시 확인합니다. 같은 검증된 SHA의 전체 CI나 이미지 빌드를 무조건 반복하지 않습니다. 비공개 수신함과 호스트 도구·설정은 준비됐지만, 첫 웹 실행이나 자료 이전 완료를 주장하지 않습니다. 현재 관리자 AWS 직접 실행 경로를 유지하며 선택적인 GitHub OIDC 활성화는 SUMZ711님 선결 작업이 아닙니다. Caddy 재설치, 이미지 빌드, IAM 임의 수정, 수신함 템플릿 실행을 SUMZ711님 작업으로 남기지 않습니다.

**SUMZ711님과 작업 에이전트가 먼저 할 일.** 본인에게 허용된 AWS 계정·CLI로 로그인해 계정 식별 결과를 확인하고, 실제 로컬 SQLite DB·업로드 파일·현재 수집기의 위치와 자동 재시작 방식을 특정합니다. SUMZ711님 계정의 대상 서버 SSM 접속과 S3 수신함 업로드 권한은 IAM 시뮬레이션에서 허용됐지만, 본인의 실제 AWS 인증·세션·업로드는 아직 시험하지 않았습니다. 권한 오류가 나면 오류와 사용 중인 계정만 관리자 측에 알려 기존 접근 경로를 조율합니다. 키나 비밀값을 PR·로그·메신저에 게시하거나 임의로 권한을 늘리지 않습니다. 지금은 원본 수집기를 미리 중지하지 않습니다.

```bash
aws sts get-caller-identity --query Account --output text
```

**준비된 수신 경로로 자료를 전달합니다.** 전달 위치는 `s3://evn-marketing-migration-902837199612-ap-northeast-2/incoming/<transfer-id>/`입니다. 이곳은 **현재 객체는 생성 후 7일, 이전 버전은 비현재 상태가 된 뒤 7일에 만료되는 비공개 수신함**이며 운영 백업 저장소가 아닙니다. 버킷 생성과 호스트의 읽기 검증은 끝났지만 SUMZ711님 계정의 실제 업로드는 아직 시험하지 않았습니다. 협의한 전환 시점에 기존 writer·수집기와 자동 재시작을 멈춥니다. 표준 백업 묶음에 DB와 업로드가 모두 들어 있으면 중복 전달하지 않습니다. 그렇지 않다면 SQLite Backup API로 일관된 DB 사본과 같은 시점의 업로드를 준비합니다. 어느 형식이든 건수·ID·receipt·체크섬·cutoff를 확인할 수 있는 비공개 manifest가 필요합니다. 실제 자료를 찾지 못하면 빈 DB나 seed로 대신하지 않습니다. 복원과 대조가 끝날 때까지 원본 DB·파일을 삭제하지 않습니다. [이전 순서](https://github.com/EVNSolution/EVN-MARKETING/blob/7aa6ca187ddffd8d3e1b27524ab72acaf207ac18/docs/dedicated-server-plan.md#L76-L87), [복원 기준](https://github.com/EVNSolution/EVN-MARKETING/blob/7aa6ca187ddffd8d3e1b27524ab72acaf207ac18/docs/backup-recovery.md).

승인된 AWS 인증으로만 다음과 같이 업로드합니다. 이는 **파일 형식의 예시**이며, 디렉터리 형식의 표준 묶음이면 작업 에이전트가 실제 구조와 복원 방식을 확인해 내용 전체를 보존하여 전송합니다. `TRANSFER_ID`, `BACKUP_FILE`, `MANIFEST_FILE`은 실제 이관 식별자와 확정된 파일 경로로 설정합니다. 업로드 파일이 별도일 때만 `UPLOADS_FILE`도 설정합니다. 명령과 결과에 개인정보나 비밀값을 남기지 않습니다. 실제 백업 파일명과 확장자를 그대로 유지하고 암호화 백업을 `marketing.sqlite`로 바꿔 부르지 않습니다. 첫 PC 자료 이전은 실제 백업 형식을 확인한 뒤 수행하는 별도 관리자 절차입니다. 운영용 `data-ops.py`는 아직 없는 `release.json`을 요구하므로 첫 이전에 곧바로 실행하거나 그 파일을 임의로 만들지 않습니다. 기존 PC 백업이 표준 묶음 형식이면 그 구조와 검증 방법을 참고할 수 있으나 같은 운영 래퍼를 바로 재사용한다고 단정하지 않습니다. 버킷의 SSE-KMS는 **S3 서버 측 암호화**이며 기존 클라이언트 암호화와 다릅니다. 기존 암호화 백업을 쓰려면 형식·복원 방법을 알려주시고 키는 기존 보안 경로로만 전달해 주세요.

```bash
: "${TRANSFER_ID:?}" "${BACKUP_FILE:?}" "${MANIFEST_FILE:?}"
aws s3 cp "$BACKUP_FILE" "s3://evn-marketing-migration-902837199612-ap-northeast-2/incoming/$TRANSFER_ID/db/$(basename "$BACKUP_FILE")" --region ap-northeast-2
if [ -n "${UPLOADS_FILE:-}" ]; then
  aws s3 cp "$UPLOADS_FILE" "s3://evn-marketing-migration-902837199612-ap-northeast-2/incoming/$TRANSFER_ID/uploads/$(basename "$UPLOADS_FILE")" --region ap-northeast-2
fi
aws s3 cp "$MANIFEST_FILE" "s3://evn-marketing-migration-902837199612-ap-northeast-2/incoming/$TRANSFER_ID/manifest/$(basename "$MANIFEST_FILE")" --region ap-northeast-2
```

**자료가 도착하면 실제 자료 복원과 서비스 시작을 진행합니다.** 작업 에이전트는 승인된 자료를 암호화된 볼륨에 복원하고 원본 건수·ID·receipt·업로드 파일과 대조합니다. 최종 이미지와 실제 DB를 검증한 다음 controller bootstrap으로 수집·전송을 끈 첫 웹 서비스를 시작하고, SUMZ711님과 기존 계정의 HTTPS 로그인을 확인합니다. 추가 인증이 필요하면 본인이 협조합니다. `manual-dispatch`로 첫 설치를 대신하거나 기존 계정을 seed로 덮어쓰지 않습니다. 이후 전송을 끈 **단일** 실제 수집기를 확인하고 WARP 전송은 기존 check/pilot 범위를 통과한 뒤 활성화합니다. WARP 서버 설정은 변경하지 않습니다.

마지막으로 실제 수집과 웹 두 개가 겹치는 대표 상황을 한 번 측정해 2 GiB 호스트의 OOM·지속 swap·여유 메모리·처리시간을 기록합니다. 웹 각 384 MiB와 worker 768 MiB는 컨테이너 상한일 뿐 실제 호스트 사용량 증거가 아닙니다. 자료가 없으면 복원·기존 로그인·단일 수집·실부하 측정을 완료로 표시하지 않습니다. [측정 기준](https://github.com/EVNSolution/EVN-MARKETING/blob/7aa6ca187ddffd8d3e1b27524ab72acaf207ac18/docs/dedicated-server-plan.md#L101-L113).

완료 보고는 이미지·보안 검사와 실제 웹 상태, 익명화된 원본/백업/복원 대조 및 기존 계정 로그인, 단일 수집·WARP와 2 GiB 측정 결과를 구분해 작성합니다. 필요한 영향 범위 검사만 수행하고 이미 끝난 CI·PR 정리, 매번 30분 관측이나 7일 대기를 다시 요구하지 않습니다.
