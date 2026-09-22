# M4 백업·복원 및 전송 이력 복구

이 도구는 일반 무중단 release와 구분된 **승인된 유지보수 시간**에 실행합니다. `deploy/data-ops.py`는 기존 배포와 같은 `state/host.lock`을 잡습니다. 모든 관리 대상 웹/수집기를 정상 종료하고 해당 볼륨을 쓰는 다른 컨테이너가 없는지 검사합니다. 별도 Mac·호스트 프로세스·자동 재실행 작업의 중지는 운영자가 확인해야 합니다. 서로 다른 DB의 lease는 다른 실행 장소를 차단하지 않습니다.

## 일관된 백업

검토된 호스트에서 관리자가 실행하는 명령이며 이 문서를 작성하면서 운영 명령을 실행하지 않습니다.

```sh
python3 -I deploy/data-ops.py backup
```

- 실제 Docker 데이터 경로의 block device를 `findmnt`/`lsblk`로 확인하고, 설정한 Marketing EBS와 일치하며 암호화돼 있는지 AWS에 조회합니다. 다른 볼륨·비암호화·불명확한 장치는 거부합니다.
- `maintenance` 상태를 먼저 기록하므로 중단·재부팅 후 일반 배포/자동 복구가 writer를 켜지 못합니다. 정상 종료·lease 해제 뒤 SQLite backup API와 파일 복사로 `/data/backups/<backupId>`를 만듭니다. DB 하나의 단순 복사는 사용하지 않습니다.
- source와 복사본의 모든 업무 테이블·migration 이력·사용자 해시·전송 receipt를 내부에서 대조합니다. 파일의 경로·크기·hash, DB의 명함/연락처 명함/문서 참조, 무결성과 외래키를 검사합니다. 원본은 최신 상태 그대로 남깁니다.
- root 소유의 비공개 staging 안에 DB/파일과 비공개 `inventory.json`을 둡니다. 검토용 `backup-summary.json`은 소스 revision·migration checksum·집계·hash만 포함합니다. 완료 표시는 마지막에 쓰고 fsync합니다. 불완전 묶음·symlink·hardlink·누락 참조·추가 WAL·hash 불일치는 복원하지 않습니다.
- 서비스 재개 후 변경하지 않는 staging을 포함한 EBS snapshot을 요청합니다. 응답은 `backupId`, `snapshotId`, `restoreVerified:false`입니다. 요청 성공이나 같은 디스크의 staging만으로 배포용 `backup.json`을 만들지 않습니다. snapshot 응답이 유실되면 `BackupId` 태그로 관리자가 먼저 확인하며 자동 중복 요청하지 않습니다.

실패 시 원본과 staging을 보존합니다. 원인을 해결하고 원본을 재개하려면 `python3 -I deploy/data-ops.py resume`을 명시적으로 실행합니다. 이 명령은 schema·lease·관리 대상 컨테이너를 다시 확인합니다. DB를 과거 백업으로 덮어쓰지 않습니다.

## 별도 볼륨 복원과 백업 완료 증거

관리자가 snapshot 완료를 확인하고 **해당 snapshot에서 별도 암호화 EBS를 생성·연결·마운트**한 다음, 그 안의 staging 경로를 넘깁니다. EBS 생성/연결/마운트는 이 도구가 수행하지 않습니다.

```sh
python3 -I deploy/data-ops.py verify-snapshot-restore --backup-id BACKUP_ID --bundle RESTORED_STAGING_DIRECTORY
```

AWS의 snapshot 완료·원본 볼륨·생성 시각, 마운트 장치의 실제 EBS ID와 `SnapshotId`를 대조합니다. 원본 EBS에서 재검사한 것을 복원 증거로 받아들이지 않습니다. 그 묶음을 새 `evn-marketing-restore-<UUID>` Docker 볼륨에 복원하고 전체 내용·파일·schema를 재검사한 후에만 기존 release gate 형식의 `state/backup.json`을 기록합니다. 시간·manifest hash·복원 볼륨·복구 소요 시간을 남깁니다.

이미 준비된 비공개 묶음의 개별 리허설은 다음 명령을 사용합니다. 이 경로는 snapshot 복원 증거를 발급하지 않습니다.

```sh
python3 -I deploy/data-ops.py restore --bundle BUNDLE_DIRECTORY --sha256 REVIEWED_SUMMARY_SHA256
```

항상 새 빈 볼륨을 쓰며 기존 볼륨을 지우거나 활성화하지 않습니다. 실패한 후보도 자동 삭제하지 않습니다. runtime 이미지에서 실제 UID/GID를 읽어 복원본 소유권을 설정합니다. 현재 runtime은 고정 운영 볼륨만 허용하므로 후보의 운영 활성화는 M5의 별도 이전 절차입니다.

## migration 전용 이미지

`Dockerfile`의 `operations` target에는 같은 소스의 Prisma CLI와 migrations가 포함됩니다. 일반 runtime에는 이 CLI와 seed를 넣지 않습니다. 운영 게시 때 runtime과 ops의 소스 SHA·각 ECR digest·검사 결과를 함께 기록해야 합니다. ops 태그는 `ops-<source SHA>`처럼 runtime의 immutable SHA 태그와 구분합니다.

```sh
docker build --target operations --build-arg MARKETING_BUILD_REVISION=SOURCE_SHA -t OPS_IMAGE .
python3 -I deploy/data-ops.py migrate-check --restore-volume RESTORE_VOLUME --ops-digest REVIEWED_OPS_DIGEST
```

복원 전용으로 표시된 미사용 볼륨에만 실행합니다. runtime/ops manifest가 같아야 하며, 실행 전후 모든 행·전송 이력·파일 내용이 같아야 성공입니다. 현재 schema가 같으므로 migration은 no-op이 기대값입니다. schema 변경·baseline·기존 DB 수리·운영 볼륨 migration은 자동 허용하지 않습니다. 향후 expand 변경은 별도 검토와 복원본 리허설이 필요합니다.

## 제한된 전송 이력 복구

WARP API는 읽기 전용 receipt 조회를 제공하지 않습니다. `recovery-plan`은 **로컬 상태만 비교**하며 원격 누락을 확정하지 않습니다. 운영자가 WARP 쪽 복원/대조 결과로 고른 sourceId 최대 20개를 사용합니다. 일반 worker는 완료 이력을 계속 건너뜁니다.

입력·계획·감사 파일은 암호화된 Marketing EBS의 전용 비공개 디렉터리에 둡니다. 디렉터리 `0700`, 파일 `0600`, 소유자는 runtime 이미지의 UID여야 합니다. 업로드 디렉터리에 두거나 Git·문서·CI artifact·터미널에 내용을 출력하지 않습니다. 비밀 키는 파일/인자 대신 지정한 SSM SecureString에서 자식 프로세스 환경으로만 전달합니다.

```sh
python3 -I deploy/data-ops.py recovery-plan --input PRIVATE_IDS_JSON --output PRIVATE_PLAN_JSON
python3 -I deploy/data-ops.py recovery-apply --plan PRIVATE_PLAN_JSON --approve-sha256 REVIEWED_PLAN_SHA256
```

plan은 네트워크가 차단된 컨테이너에서 실행합니다. apply는 검토한 계획 hash가 일치해야 하며 전체 대상·scope·현재 payload/기존 receipt의 fingerprint를 확인합니다. 같은 host lock과 worker lease 아래 승인된 대상만 기존 HTTPS endpoint로 재전송하고 수신 확인을 검증합니다. 원래 sourceId·결정적인 activityId를 유지합니다. 응답 유실 후에는 새 로컬 계획을 검토해 다시 실행할 수 있으며 원격 중복 응답으로 복구합니다. 충돌·잘못된 receipt·중단 시 전체 완료 이력을 지우지 않고 멈추며, 부분 결과와 감사 기록을 검토한 후 재개합니다.

## 검사와 증거 범위

`npm run test:backup`, `npm run test:warp-recovery`와 기존 data-recovery 검사는 합성 자료만 사용합니다. Linux CI는 최종 runtime의 실제 backup/restore 명령, 별도 ops 이미지의 migration no-op, 복원한 자료로 실제 로그인·신/구 화면·동시 업로드를 검사합니다. 두 웹과 Chromium의 cgroup `memory.peak`를 측정합니다. 구성 요소별 최고치의 합은 보수적 상한이며 같은 순간의 사용량이나 운영 서버 사양 확정값이 아닙니다.

성공한 CI의 `marketing-recovery-<merge SHA>` artifact에는 익명 집계·복원 시간·빌드 이미지 ID·메모리 최고치만 7일간 보관합니다. 실제 DB/파일·개인정보·대상 sourceId·키·세션은 보관하지 않습니다. ECR digest는 실제 게시 이후 별도 증거입니다.

AWS host role 선언에는 지정한 Marketing EBS의 snapshot 생성과 생성 시 태그 부여만 추가했습니다. snapshot 삭제·볼륨 생성/연결이나 WARP 자원 권한은 추가하지 않습니다. 생성 태그 권한은 [AWS EBS 정책 예제](https://docs.aws.amazon.com/ebs/latest/userguide/security_iam_id-based-policy-examples.html)의 자원 분리와 `ec2:CreateAction` 조건을 따릅니다. 선언 검사는 실제 IAM simulation·KMS/EC2 권한·snapshot 복원 실행을 대신하지 않습니다.

운영 전에는 실제 off-host snapshot 복원, 암호화/KMS 권한, RPO 24시간·RTO 60분 달성 여부, 일일 7개/주간 4개 보관 설정, 서버 자원 여유, 기존 Mac의 재시작 차단, 호스트 재부팅·SSM 중단 복구를 확인해야 합니다. 자동 snapshot 삭제와 보관 스케줄은 현재 도구에 포함하지 않으며 검증된 백업을 임의 삭제하지 않습니다. 실제 데이터 이관·서비스 공개는 M5에서 수행합니다.
