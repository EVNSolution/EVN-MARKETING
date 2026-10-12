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

## 전환과 관찰

SSM은 root 소유의 고정 bundle을 검증하고 `deploy/start-release.py`를 실행한다.
이 helper는 `marketing-deploy.service`라는 systemd transient unit으로 기존 controller를 실행한다.
동일 이름의 활성 unit은 두 번째 요청을 거부한다. Controller의 host lock도 유지한다.

새 웹 readiness, 기존 worker 종료·lease 해제, 새 worker 준비·활성화까지 확인하면 Actions가 끝난다.
이 성공은 `observing` 상태를 의미한다. 서버는 기존 1,800초 관찰과 자동 복귀를 계속 수행한다.
`state/release.json`의 `phase=stable`과 예상 active SHA/digest를 확인해야 관찰 완료다.
기존 웹 자산·진행 요청 drain과 데이터 볼륨은 유지한다. 새 배포는 관찰 완료까지 차단한다.
GitHub/SSM 연결이 끊겨도 systemd 프로세스는 계속된다. 호스트 재부팅은 기존 recover unit이 복귀한다.
응답 유실 시 재실행하지 말고 SSM command ID, systemd unit, release journal을 먼저 확인한다.

## 롤백

```sh
npm run deploy:rollback -- --source-sha CURRENT_MAIN_SHA
```

대상은 호스트 journal의 previous release다. 임의 이미지나 오래된 DB로 바꾸지 않는다.
현재 DB와 uploads를 유지하고 두 버전의 schema 호환성을 확인한다.

## 데이터와 권한

배포에는 24시간 이내 암호화 EBS snapshot과 별도 볼륨 복원 검증이 필요하다.
`data-ops.py backup --keep-web`은 웹을 유지하고 worker만 정상 종료한다.
복사 전·복사본·복사 후 DB 행과 업로드 hash가 같아야 백업을 인정한다.
동시 수정으로 검증이 실패하면 백업을 거부하고 worker를 복구한다.
기존 완전 정지 백업과 복원 검증 명령도 유지한다. 원본 볼륨은 교체하지 않는다.

GitHub production environment는 main 브랜치만 허용한다.
OIDC trust는 실제 저장소 immutable subject와 production environment를 정확히 제한한다.
저장소 변수: MARKETING_AWS_ACCOUNT_ID, MARKETING_INSTANCE_ID,
MARKETING_SSM_DOCUMENT_VERSION, MARKETING_SSM_DOCUMENT_SHA256.
애플리케이션 비밀값은 호스트의 SecureString에 유지한다.
배포 역할은 Marketing ECR과 고정 Marketing SSM 문서·인스턴스만 사용한다.
컨트롤러 bundle 또는 SSM 문서가 바뀌면 관리자가 검증된 파일과 문서 hash를 먼저 설치한다.

## CI 비용

코드 검사와 이미지 빌드를 병렬 실행한다. 빌드한 이미지를 application·controller transitions·controller recovery 작업에 자동 전달한다. 최종 images gate가 모든 필수 작업과 검사 증거를 대조한다. 배포는 전체 CI 성공을 요구한다.
runtime·operations·고정 schema bridge·proxy에 각각 BuildKit GHA cache scope를 사용한다.
브라우저 검사와 두 controller 작업은 독립 실행 환경에서 실행한다. 복구 8개 시나리오는 한 DB에서 순서대로 실행하며 신규 데이터 보존을 계속 확인한다.
같은 proxy 이미지를 두 검사에서 재사용한다.
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

실제 시간 합성 관찰이 필요하면 Linux에서 다음 명령을 실행한다.

```sh
docker build --target application --build-arg MARKETING_BUILD_REVISION="$GITHUB_SHA" -t evn-marketing:controller-base .
python3 tests/deploy-controller-lab.py --real-time --report REPORT_PATH
```

이 합성 검사는 운영 배포 완료 증거를 대신하지 않는다.
