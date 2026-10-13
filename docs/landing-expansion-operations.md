# 홈페이지 문의 DB 확장 실행 절차

새 운영 도구 `deploy/landing-expand.py`는 고정된 baseline→홈페이지 문의 확장만 실행한다. 일반 release, backup, recovery와 같은 `state/host.lock`을 사용한다. 운영 실행·서버 설치·서비스 중지는 기존 사용자 승인 조건의 대상이다. 코드나 이 문서가 승인 자체를 대신하지 않는다.

## 배포 원본과 선행 순서

1. PR #29의 정확한 검사 통과 head와 tree를 확인한다. 검토·병합 후 실제 원격 main의 merge SHA를 배포 원본으로 고정한다. 호환성 테스트의 `d6d7df889f1a1ca52769a1615e352034f09c3bb8`는 선행 앱 소스이고, 운영 도구는 main의 병합 SHA를 요구하므로 실제 배포 SHA 및 tree 대응을 별도로 기록한다. DB 변경 없이 선행 runtime을 배포하고 조건 기반 초기 검증을 마친다. 이전 연결은 슬롯 재사용 시 drain한다.
2. 그 활성 선행 SHA/digest에 대응하는 새 일관 백업과 별도 복원 증거를 준비한다. 기존 버전에서 만든 backup.json을 선행 버전의 증거로 임의 수정하지 않는다. 이 도구는 활성 source와 일치하며 24시간 이내인 기존 검증 증거를 요구한다.
3. PR #28의 최종 head 전체 CI를 통과시킨 뒤 검토·병합하고 실제 main SHA를 고정한다. 기존 `deploy:publish`와 새 `deploy:publish-ops`로 같은 source의 runtime/operations 이미지를 각각 게시한다. 후자는 `<main-sha>-ops` 태그이며 runtime처럼 배포 명령을 보내지 않는다. operations도 ECR 검사에서 HIGH/CRITICAL/UNDEFINED를 거부하고 source/계정을 다시 확인한 뒤 완료로 보고한다. 두 digest를 기록한다.
4. 설치할 `controller.py`, `landing-expand.py` 및 기존 의존 파일의 정확한 hash·차이, SSM 검증값의 갱신 범위, 백업/복원 비용·서비스 중지 단계를 정리하여 사용자 승인 조건을 적용한다. SSM은 서버에 설치한 controller를 자동 갱신하지 않는다. 소유자 root, group/world 쓰기 금지, 실제 절대 경로와 부모 권한을 유지한다. `landingIntakeEnabled`는 false여야 한다. 기존 수집/WARP 설정·키는 변경하지 않는다.

## 복원본 리허설

검증된 backup.json의 미사용 `restoreVolume`에서만 실행한다. Docker volume label, 활성 source, 두 이미지의 revision/manifest/capability, 고정 계약, 백업·암호화 저장장치를 재확인한다.

```text
python3 /opt/evn-marketing-runtime/deploy/landing-expand.py rehearse \
  --revision <검증한-main-sha> --runtime-digest <runtime-sha256> --ops-digest <operations-sha256>
```

정식 `prisma migrate deploy` 전후에 기존 모든 테이블 행과 내용 hash, 업로드 경로·크기·내용 hash, 기존 migration 이력을 비교한다. 새 테이블 둘은 비어 있어야 한다. 성공할 때만 root 전용 `state/landing-expand-plan.json`과 그 SHA-256이 만들어진다. 해당 복원본은 이제 확장된 검증본이므로 동일한 baseline 리허설을 반복할 때는 별도 복원본과 증거를 다시 준비한다. 원본 DB에는 쓰지 않는다.

## 운영 적용과 중단 시 처리

계획 내용·source/digest·복원 증거를 검토하고 기존 승인 조건을 충족한 다음, 출력된 계획 hash를 명시한다.

```text
python3 /opt/evn-marketing-runtime/deploy/landing-expand.py apply --approve-sha256 <검토한-plan-sha256>
```

계획 파일의 소유자/권한/hash, 활성 release와 config hash, 백업 식별자와 유효 기간을 서비스 중지 전에 재확인한다. 공통 잠금 아래 유지보수 상태를 기록하고 수집기를 정상 종료해 lease를 해제한 뒤 두 web을 중지한다. 알 수 없는 volume writer가 있으면 진행하지 않는다. 마지막 쓰기까지 포함한 추가 일관 복사본을 `/data/backups/landing-<operation-id>`에 보관하고 완료 hash를 journal에 기록한 뒤에만 Prisma migration을 실행한다.

정확한 확장 계약·정상 이력·무결성과 기존 데이터/업로드 보존을 확인한 후 선행 앱을 재개한다. 이 명령은 홈페이지 접수를 켜거나 기능 이미지로 전환하지 않는다. 오류나 응답 유실은 유지보수 상태와 검증 근거를 남긴다.

```text
python3 /opt/evn-marketing-runtime/deploy/landing-expand.py resume
```

변경 전 상태이면 기존 계약을 확인하고 재개한다. migration 완료 후 응답만 유실됐다면 저장한 전후 근거로 보존을 다시 검증한다. 부분 DDL, 미완료 이력, 데이터 차이, 알 수 없는 writer는 재개하지 않는다. 자동 down migration, 백업 덮어쓰기, 임의 이력 수선은 없다. 이 경우 서비스는 중지 상태를 유지하며 별도 복구 판단과 사용자 승인 경계를 적용한다. 일반 `data-ops.py resume`를 이 유지보수 상태에 사용하지 않는다.

## 공개 전환

선행 앱이 확장 DB에서 정상 동작한 뒤 기존 release 절차로 기능 runtime을 배포한다. 접수 비활성 상태에서 landing/관리자 접근을 확인하고, 승인된 설정 변경 및 web 재시작 절차로 접수를 켠다. 실제 공개 경로의 합성 상담 1건이 Inquiry의 새 홈페이지 필터에 저장되고 중복 재전송이 1건이며 고객 생성/WARP 전송이 없는지 확인한다. 테스트 개인정보는 관리자 종료 기능으로 삭제한다. 공개 접속만 성공했을 때는 실제 접수 완료라고 보고하지 않는다.

## 검증 범위

- Node 합성 DB 검사: baseline/expanded 읽기 전용 증거, 행·파일·이력 변조, 조기 접수, 부분 schema 거부.
- Python 모델 검사: 승인·권한·기한·source/config/backup 경계, writer 중지→최종 복사→migration 순서, 부분 변경 거부, 완료 응답 유실 재개, 재개 실패 상태 보존. Windows에서는 Linux 잠금·fsync와 실제 Docker/AWS 효과를 검증했다고 주장하지 않는다.
- operations 게시 검사: 실제 runtime 태그와 구분, 고정 source archive 및 label, audit 실패 시 무게시, 운영 dispatch 없음.
- Linux CI 및 실제 복원본 리허설은 별도로 모두 완료해야 한다.
