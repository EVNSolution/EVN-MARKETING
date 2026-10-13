# Marketing CI와 배포

CI는 `.github/workflows/ci.yml`, 배포는 `.github/workflows/deploy.yml`에서 실행한다.
이 문서가 현재 절차다. 이전 로컬 publish와 세 개의 기존 workflow는 제거했다.

## 배포

1. PR의 `Marketing CI / verify`와 다른 필수 검사를 확인한다.
2. PR을 main에 병합한다. main CI가 해당 SHA를 검사하고 이미지를 한 번 빌드한다.
3. main CI가 성공하면 해당 실행의 `marketing-release-<SHA>` artifact를 확인한다.
4. 아래 명령으로 배포한다. `SOURCE_SHA`는 현재 main, `CI_RUN_ID`는 성공한 main CI 실행 번호다.

```sh
npm run deploy -- --source-sha SOURCE_SHA --ci-run-id CI_RUN_ID
```

배포 workflow는 CI 실행의 저장소·workflow·push 이벤트·main·성공 상태·SHA를 검사한다.
Artifact의 실행 번호·SHA·컨트롤러 bundle hash·image digest를 대조한다.
ECR의 불변 SHA 태그와 최근 보안 검사도 다시 확인한다. 배포에서 이미지 빌드나 npm 설치는 하지 않는다.

## 초기 검증과 이전 화면 보호

SSM은 root 소유의 고정 bundle을 검증하고 `deploy/start-release.py`를 실행한다.
이 helper는 `marketing-deploy.service`라는 systemd transient unit으로 기존 controller를 실행한다.
동일 이름의 활성 unit은 두 번째 요청을 거부한다. Controller의 host lock도 유지한다.

기존 worker 종료와 이전 웹 정리 전에 프록시 사전 검사를 자동 실행한다.
새 버전과 복구용 버전의 실제 컨테이너 사용자로 renderer 파일을 읽고 설정을 생성한다.
생성한 설정은 네트워크와 운영 데이터가 없는 별도 Nginx 컨테이너에서 문법을 검사한다.
권한·파일 누락·설정 오류가 있으면 `proxy_preflight_failed`로 배포를 거부한다.
기존 웹·worker·프록시 설정·배포 journal은 변경하지 않는다. 작업자가 선택하거나 생략할 수 없다.

새 웹 readiness, 기존 worker 종료·lease 해제, 새 worker 준비·활성화까지 확인하면 `Marketing activate` Actions가 끝난다.
이 성공은 활성화 확인이다. 서버는 공개 웹 정상 응답 5회와 활성화 이후 worker heartbeat 갱신을 확인한다.
응답 확인 간격은 2초다. 조건을 충족하면 즉시 stable로 확정한다. 90초는 실패 판정 상한이며 고정 대기가 아니다.
공개 응답·worker 상태 실패 또는 heartbeat 미갱신 시 기존 버전으로 자동 복귀한다. 러너는 이 검증을 기다리지 않는다.
서버는 시작 전에 GitHub production deployment를 만들고 `in_progress`를 기록한다.
최종 상태는 [GitHub Deployments](https://github.com/EVNSolution/EVN-MARKETING/deployments)에 자동 기록한다.

| 서버 결과 | GitHub deployment 상태 |
|---|---|
| 검증 종료, 대상 SHA/digest가 stable | success |
| 배포 실패, 이전 버전 복귀 확인 | failure — rollback succeeded |
| 사전 검사 실패, 기존 버전 유지 확인 | failure — original version restored/retained |
| 복귀 또는 복구 확인 불가 | error — recovery unconfirmed |
| 명시적 rollback 정상 완료 | success — rollback completed |

CI 빌드와 활성화 job은 `environment.deployment: false`를 사용한다.
OIDC와 main 환경 제한은 유지하되, job 종료가 production deployment를 자동 성공 처리하지 않는다.
서버의 배포 기록에는 대상 SHA/digest, 요청 실행 번호, 원래 Actions 링크를 남긴다.
기존 Actions 실행의 conclusion을 나중에 바꾸지 않는다. 고정 30분 대기와 만료 타이머는 제거했다.

`deploy/deployment-result.py`는 기존 controller를 같은 host lock 안에서 실행한다.
데이터 볼륨, worker lease, 진행 요청 drain을 유지한다.
GitHub/SSM 연결이 끊겨도 systemd 프로세스는 계속된다. 호스트 재부팅은 기존 recover unit이 복귀한다.
최종 결과를 `state/deployment-results/<request-key>.json`에 먼저 저장한다.
GitHub 전송 실패는 배포 결과를 바꾸지 않는다. `marketing-result.timer`가 60초 간격으로 미전송 결과만 재시도한다.
재부팅 시 미완료 요청은 controller/recover가 끝나고 host lock을 얻은 뒤 journal과 대상 SHA/digest로 판정한다.
이전 배포 결과는 이후 배포의 journal로 덮어쓰지 않는다. 응답 유실 시 같은 요청의 deployment/status를 재사용한다.
호스트가 꺼져 있거나 GitHub가 불통이면 결과 전달은 복구 후 이루어진다. 외부 장애 감시는 이 기능에 포함하지 않는다.

초기 검증이 끝나면 다음 배포를 허용한다. 이전 화면 보호 기간 때문에 다음 배포를 차단하지 않는다.
현재 버전과 직전 버전의 웹을 유지한다. 다음 전진 배포가 직전 버전의 슬롯을 재사용할 때 매핑을 제거한다.
기존 Nginx worker의 진행 중 요청이 끝난 뒤에만 이전 웹을 정리한다. 180초 안에 drain이 끝나지 않으면 슬롯을 재사용하지 않는다.
직전보다 오래된 화면은 409 응답과 갱신 안내를 받는다. 입력 내용을 유지하며 쓰기 요청을 다른 버전으로 자동 재전송하지 않는다.
응답 유실 시 재실행하지 말고 기록된 요청과 SSM command ID를 확인한다.

### 최초 결과 기록 연결

마케팅에 설치된 GitHub App을 사용한다. 설치 범위는 `EVNSolution/EVN-MARKETING` 한 개,
권한은 `Deployments: read/write`와 필수 `Metadata: read`다. Contents/Actions 권한은 필요 없다.
개인 토큰이나 Actions의 `GITHUB_TOKEN`을 호스트에 복사하지 않는다.

마케팅 전용 KMS 키로 다음 JSON을 SecureString `/evn-marketing/production/github-deployment-app`에 저장한다.
실제 값은 로그·PR·채팅에 넣지 않는다.

```json
{"appId": 123, "installationId": 456, "privateKey": "PEM private key"}
```

`deploy/aws/cloudformation.json`의 host 역할만 이 파라미터와 해당 KMS encryption context를 읽는다.
컨트롤러 bundle에 reporter와 timer/service도 포함된다. 검증한 bundle과 SSM 문서를 설치한 뒤 다음을 실행한다.
`deploy/nginx-config.mjs`는 컨테이너의 일반 사용자가 읽으므로 root 소유, `0644`로 설치한다.
호스트 전용 Python 파일의 `0600` 권한을 renderer에 적용하지 않는다.
배포 사전 검사는 설치 권한이 잘못된 경우에도 서비스 전환 전에 자동으로 차단한다.

```sh
install -o root -g root -m 0644 deploy/marketing-result.service deploy/marketing-result.timer /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now marketing-result.timer
```

기존 설치를 업그레이드할 때는 host lock 아래에서 검증된 bundle을 설치하고,
`marketing-release.timer`를 중지·비활성화한 뒤 기존 expiry service/timer 파일을 제거한다.
`marketing-result.timer`와 `marketing-recover.service`는 유지한다. 기존 journal의 `expiresAt`는 무시한다.
이후 설치에는 expiry service/timer가 없다.

초기 설정은 배포 전에 한 번 수행한다. 이후 작업자 입력은 기존 배포 명령과 같다.
타이머나 GitHub 인증이 준비되지 않으면 서비스 전환 전에 거부한다.
App 설치 토큰은 실행 시 발급하며 저장소 한 개와 배포 쓰기 권한으로 다시 제한한다.
토큰·개인 키·GitHub 오류 응답 본문은 결과 파일과 SSM 출력에 남기지 않는다.

## 롤백

```sh
npm run deploy:rollback -- --source-sha CURRENT_MAIN_SHA
```

대상은 호스트 journal의 previous release다. 임의 이미지나 오래된 DB로 바꾸지 않는다.
현재 DB와 uploads를 유지하고 두 버전의 schema 호환성을 확인한다.

## 데이터와 권한

배포에는 24시간 이내 암호화 EBS snapshot과 별도 볼륨 복원 검증이 필요하다.
`data-ops.py backup --keep-web`은 웹을 유지하고 worker만 정상 종료한다.
직전 버전의 웹도 유지하며 보호 시간 때문에 백업을 차단하지 않는다.
복사 전·복사본·복사 후 DB 행과 업로드 hash가 같아야 백업을 인정한다.
동시 수정으로 검증이 실패하면 백업을 거부하고 worker를 복구한다.
기존 완전 정지 백업은 이전 매핑의 요청을 자동 drain한 뒤 두 웹을 정지한다. 복원 검증 명령도 유지한다. 원본 볼륨은 교체하지 않는다.

GitHub production environment는 main 브랜치만 허용한다.
OIDC trust는 실제 저장소 immutable subject와 production environment를 정확히 제한한다.
저장소 변수: MARKETING_AWS_ACCOUNT_ID, MARKETING_INSTANCE_ID,
MARKETING_SSM_DOCUMENT_VERSION, MARKETING_SSM_DOCUMENT_SHA256.
애플리케이션 비밀값은 호스트의 SecureString에 유지한다.
배포 역할은 Marketing ECR과 고정 Marketing SSM 문서·인스턴스만 사용한다.
컨트롤러 bundle 또는 SSM 문서가 바뀌면 관리자가 검증된 파일과 문서 hash를 먼저 설치한다.

## CI 비용

코드 검사, 배포용 runtime 빌드·검사, controller 전용 이미지 빌드를 병렬 실행한다. 작은 controller 이미지만 transitions·recovery 작업에 자동 전달한다. runtime은 빌드한 환경에서 바로 검사·게시한다. 최종 images gate가 모든 필수 작업과 검사 증거를 대조한다. 배포는 전체 CI 성공을 요구한다.
runtime·operations·고정 schema bridge·proxy에 각각 BuildKit GHA cache scope를 사용한다.
브라우저 검사와 두 controller 작업은 독립 실행 환경에서 실행한다. 복구 8개 시나리오는 한 DB에서 순서대로 실행하며 신규 데이터 보존을 계속 확인한다.
transitions 작업은 renderer 읽기 권한 오류·파일 누락·JavaScript 오류·Nginx 문법 오류와 rollback 권한 오류를 실제 컨테이너로 재현한다.
각 거부 뒤 기존 컨테이너 ID·프로세스·worker 활성화 파일·프록시 설정·journal이 같은지 확인한다.
다섯 시나리오의 성공 증거가 누락되면 최종 images gate가 실패한다.
proxy는 같은 고정 Dockerfile과 캐시를 사용한다.
operations와 bridge는 compatibility 경로에서만 준비한다.
검사 선택은 `.github/scripts/classify_pr.py`가 Git 변경 경로로 결정한다.
실행자·PR label·수동 입력으로 검사를 생략할 수 없다.
일반 화면은 compatibility, worker와 명시된 호스트 배포 파일은 controller lab을 추가한다.
`deploy/aws/release.py`, `deploy/aws/operator-release.py`와 해당 cloud/manual/operator 테스트만
변경하면 추가 Docker lab을 생략한다. 두 helper는 Docker lab에서 실행되지 않는다.
관련 단위 테스트, runtime 빌드, smoke는 이 경우에도 항상 실행한다.
공유 코드·의존성·API·schema·CI/분류 규칙 변경이나 미분류 파일은 둘 다 검사한다.
여러 종류를 함께 변경하면 필요한 검사를 모두 합친다. 삭제와 rename 이전 경로도 평가한다.
PR은 base와 head의 merge-base diff, main push는 before와 after 전체 diff를 사용한다.
diff 실패·빈 변경·새 브랜치·이력 재작성·수동 실행은 둘 다 검사한다.
분류 출력이 누락되거나 잘못되면 CI가 실패하므로 배포할 수 없다.
Actions 요약에는 비교 SHA, 경로별 판단 근거, 최종 검사 선택을 기록한다.
main 이미지는 실제 merge SHA로 검증한다.

controller transitions·recovery는 CI에서 실제 시계로 실행한다. 가속 시계나 별도 장시간 관측 모드는 없다.
A→B→C→B→A 연속 전환, 각 초기 검증, 진행 요청 drain 2회와 복구 8개 시나리오가 필수다.
이 합성 검사는 운영 배포 완료 증거를 대신하지 않는다.
