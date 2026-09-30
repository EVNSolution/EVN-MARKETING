# EV&Marketing 로컬 셀프 배포

이 도구는 현재 원격 `main`과 정확히 같은 깨끗한 체크아웃만 허용한다. `main`에 병합된 PR의 고정 head SHA에서 `pr.yml`의 최신 실제 실행과 `verify` job이 성공했는지 다시 확인하고, 기존 `deploy/aws/release.py`의 AWS 주체·Marketing 전용 EC2·불변 이미지·24시간 이내 스캔·고정 SSM 문서 검증을 그대로 통과해야 한다. PR 종료 시 생기는 skipped 실행은 이전 성공을 가리지 않도록 제외하지만, 현재 롤업의 실패·대기는 거부한다. 기술 검증은 사업 승인이나 운영 권한 위임을 뜻하지 않는다.

## 1회 설정

Python 3, Node.js/npm, `gh`, AWS CLI, Docker/Buildx, Amazon ECR credential helper가 필요하다. `gh`와 `AWS_PROFILE`은 각자 승인된 계정으로 로그인한다. 이미지 게시 전에는 전용 Colima 프로필과 소켓을 명시한다.

```sh
colima start --profile evn-marketing
export DOCKER_HOST="unix://$HOME/.colima/evn-marketing/docker.sock"
docker buildx version
```

`publish`가 만드는 임시 `DOCKER_CONFIG`에는 credential helper 연결만 들어가므로 Docker context를 대신 선택하지 않는다. 위 `DOCKER_HOST`는 빌드와 게시 과정에 그대로 전달된다. 아래처럼 비밀이 아닌 기존 식별자만 JSON에 저장한다. 키를 더 넣거나 환경 스크립트를 실행하는 방식은 지원하지 않는다.

```json
{
  "AWS_PROFILE": "marketing-operator",
  "MARKETING_AWS_ACCOUNT_ID": "123456789012",
  "MARKETING_INSTANCE_ID": "i-0123456789abcdef0",
  "MARKETING_DEPLOYER_ARN": "arn:aws:sts::123456789012:assumed-role/MarketingReleaseOperator/operator-name",
  "MARKETING_SSM_DOCUMENT_VERSION": "3",
  "MARKETING_SSM_DOCUMENT_SHA256": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
}
```

예시는 `operator.json`으로 저장하되 저장소에는 커밋하지 않는다. 예상 주체 ARN은 `whoami` 결과에서 자동 생성하지 않고 관리자가 승인한 값을 그대로 고정한다.

## 실행

먼저 원격 `main`을 새로 받아 해당 SHA를 체크아웃하고 작업 트리가 깨끗한지 확인한다. 도구는 브랜치 병합, `main` 체크아웃, 사용자 파일 초기화, IAM 설치, SSM 문서 생성을 하지 않는다.

```sh
npm run deploy:check -- --config /absolute/path/operator.json
npm run deploy:publish -- --config /absolute/path/operator.json
npm run deploy -- --config /absolute/path/operator.json
npm run deploy:rollback -- --config /absolute/path/operator.json
```

- `deploy:check`: 현재 SHA 태그 이미지를 조회하고 클라이언트의 소스·CI·AWS 주체·대상·이미지·스캔 조건을 읽기 전용으로 검사한다. 이미지는 만들지 않고 SSM 명령도 보내지 않는다. 호스트의 백업·readiness는 조회하지 않으며, 릴리스 명령이 원격 컨트롤러를 실행할 때 기존 게이트가 강제한다.
- `deploy:publish`: 이미지가 없을 때만 고정 SHA의 `git archive`를 표준입력으로 전달해 Linux amd64 이미지를 빌드한다. 기본 provenance 메타데이터를 비활성화해 SHA 태그가 ECR 기본 스캔 가능한 단일 runtime manifest를 가리키도록 한다. 소스 revision·출처 라벨·불변 digest·CI·취약점 검사 조건은 유지한다. live 작업 폴더의 개발 파일이나 무시된 파일은 이미지에 들어가지 않고, archive에 포함된 기존 `.dockerignore`도 유지된다. 푸시 직전에 깨끗한 현재 `main`과 고정 AWS 주체·대상을 다시 확인한다. 정확한 `ImageNotFoundException`만 미존재로 취급하며 네트워크·권한 오류에서는 중단한다. 기존 불변 태그는 재사용한다. 임시 Docker 설정에는 ECR credential helper 이름만 기록하며 로그인 토큰은 만들지 않는다. 이후 최신 스캔까지 검사하며 SSM 명령은 보내지 않는다.
- `deploy`: 같은 게이트를 다시 통과한 뒤에만 고정 SSM 문서로 릴리스를 전송하고 완료를 기다린다.
- `deploy:rollback`: 서버에 저장된 `previous` 릴리스만 대상으로 같은 SSM 경계를 사용한다.

`deploy:check`, `deploy:publish`, `deploy`는 과거 PR 결과만 신뢰하지 않고, 깨끗한 현재 lockfile을 대상으로 매번 `npm audit --omit=dev --audit-level=high`를 새로 실행한다. 설치나 `npm ci`는 수행하지 않으며 high 이상 production dependency 취약점이나 audit 조회 실패가 있으면 게시·릴리스 전에 중단한다. 롤백은 이 신규 advisory 검사 없이 기존 복구 경계를 유지한다.

아무 명령 없이 `python3 deploy/aws/operator-release.py`를 실행하면 도움말만 표시한다. 배포와 롤백은 각각 명시적으로 실행해야 한다. 스냅샷 복구와 컨트롤러의 기존 게이트도 그대로 유지된다.

## 운영 권한

[관리자 OziinG의 2026-09-30 권한 위임](https://github.com/EVNSolution/EVN-MARKETING/pull/21#issuecomment-5903577165)에 따라 SUMZ711은 EV&Marketing 전용 서비스의 개발·검토·병합·배포·롤백 및 운영을 별도 건별 사전 승인 없이 진행할 수 있다. 첫 일관 백업과 별도 암호화 EBS 복원 검증, 짧은 서비스 중지와 임시 볼륨 생성·연결도 승인된 범위다. Marketing 전용 IAM·인프라·비밀값 변경은 변경 내용과 복구 방법을 기록한다. WARP·다른 서비스·공유 계정 전체에 영향을 주는 변경은 제외한다.

권한 위임 후에도 CI·보안 검사·백업/복원·단일 수집기·DB 호환성 검사는 유지한다. 실행 SHA·이미지 digest·SSM 작업번호·복원 검증 결과를 기록하고, 원본은 복원·대조가 끝날 때까지 보존한다. 자격증명이나 고객 개인정보를 PR에 남기지 않는다. 백업 담당과 주기는 SUMZ711이 운영 절차에 정한다.
