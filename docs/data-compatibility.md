# DB 호환성 검사와 복구 검증

M2 후속 작업입니다. 현재 릴리스는 DB 변경이 없으므로 **동일 schema만 일반 배포 허용**합니다. 호스트 배포/rollback은 [배포 컨트롤러](release-controller.md), 운영 backup/restore·승인 대상 재전송은 [M4 복구 절차](backup-recovery.md)를 따릅니다. 실제 AWS 자원 적용과 운영 이전은 별도 인수 단계입니다.

## 배포 전 읽기 전용 검사

이미지 빌드 때 `schema-manifest.json`을 만들고 `schema-check.mjs`를 실행 이미지에 포함합니다. manifest는 source revision, Prisma schema hash, migration 파일별 SHA-256, migration을 빈 메모리 DB에 적용한 최종 DDL을 담습니다. 고객 자료나 인증값은 없습니다. 실행 이미지에는 migration 실행기·Prisma CLI·seed를 넣지 않습니다.

배포 컨트롤러에서 current/previous **검증된 이미지**의 manifest를 추출하고 다음 검사를 성공한 경우에만 준비 단계를 이어갑니다. 이 검사 도구는 M3 컨트롤러의 호환성 검사에 연결되어 있습니다.

```sh
DATABASE_URL=file:/data/marketing.db node /app/schema-check.mjs check /app/schema-manifest.json /previous/schema-manifest.json
```

- 두 manifest의 Prisma schema, migration 순서/checksum, DDL이 같아야 합니다. 바뀌었으면 `schema_change_requires_review`로 중단합니다. additive 컬럼도 자동 허용하지 않습니다. 별도 expand 검토·복원본 부하 검사 후 정책을 확장해야 합니다.
- 실제 DB의 컬럼·자료형·default·외래키·인덱스·trigger를 포함한 DDL과 완료된 `_prisma_migrations` checksum을 비교합니다. 미완료/누락/중복/미등록 migration과 schema drift는 중단 사유입니다. 명시적으로 rolled back된 과거 실패 기록은 적용 완료 기록으로 세지 않습니다.
- 하나의 읽기 snapshot에서 SQLite `integrity_check`와 `foreign_key_check`까지 검사합니다. DB/ledger를 생성·수정하거나 과거 백업으로 덮어쓰지 않습니다. WAL/SHM 보조 파일은 SQLite 읽기 연결에서도 생성될 수 있습니다.
- DDL 문자열의 완전 일치를 사용하므로 의미상 같은 재구축/표현 차이도 보수적으로 거부할 수 있습니다. 불일치 시 실제 이전 절차에서 확인하고 처리하며, 자동 baseline이나 누락 이력 생성으로 우회하지 않습니다.
- 결과는 성공 여부·고정 사유 코드·공개 revision뿐입니다. 고객 데이터·경로·인증값·원문 오류를 출력하지 않습니다. 이것은 호환성 검사이며 manifest의 신뢰성 자체는 M3의 승인 image digest 대조가 보장해야 합니다.

최초 Mac DB에 migration 이력이 없으면 실패하는 것이 정상입니다. 실데이터의 실제 DDL과 적용 이력을 확인하는 이전 작업이 필요하며, 이 검사 통과를 위해 이력을 임의로 작성하지 않습니다.

## 합성 검증

- `npm run test:schema`: 동일 schema 통과, checksum/이력 누락·미완료·중복·알 수 없는 migration, 컬럼/제약/trigger 변경, 외래키 위반, 경로·누락 파일 거부와 무변경 확인.
- `npm run test:data-recovery`: 격리된 DB·첨부의 일관된 복원과 이력 보존, 코드 재시작 시 최신 자료 유지, 원격 반영 직후 응답 유실/강제 종료와 같은 식별값 재전송, 서로 다른 복원 시점의 전송 이력을 검사합니다. 실제 WARP/원본 서비스로 요청하지 않습니다.
- Linux 최종 이미지 smoke는 패키징된 검사 실행과 누락 DB 미생성을 확인합니다.
- 기존 browser 검사에서 PR #7의 고정 source `fbf325f3efc30b8913b6dd3989d93abba9af0a7c`와 현재 source를 각각 빌드합니다. 서로 다른 실제 코드 이미지가 같은 합성 DB에서 로그인·고객 저장·동시 첨부를 처리합니다. PR #7은 manifest 도입 전이므로 CI에서만 해당 고정 source로 manifest를 생성합니다. 운영에서 임의 source로 manifest를 만들어 이미지 검증을 대체하지 않습니다.
- 새 코드의 저장 결과를 이전 코드 API로 읽고 다시 수정해, 새로 저장한 다른 필드와 첨부 metadata가 보존되는지 검사합니다. 브라우저 검사 전후에 같은 DB의 schema/ledger/무결성을 다시 확인합니다.

2026-09-22 로컬에서 실제 사용 중인 DB를 읽기 전용으로 검사했고 현재 schema·완료된 migration checksum·무결성이 통과했습니다. 고객 내용이나 인증값을 출력하거나 실제 DB를 변경하지 않았습니다. 이것은 해당 시점의 로컬 확인이며 서버 이전 후 검사를 대체하지 않습니다.

현재 schema 변화가 없다는 사실과 이 두 코드 버전의 검증을 기록합니다. 임의 N/N-1 schema 변경의 호환성을 증명한 것은 아닙니다. 운영 host 잠금과 복원 명령·승인 대상 재전송 도구는 M3/M4에 구현하며, 실제 암호화 snapshot 복원과 운영 자료의 복구 시간은 별도 인수 증거가 필요합니다.

## 복구 시 전송 이력의 의미

일반 코드 rollback은 최신 DB/업로드를 그대로 사용합니다. Marketing DB가 과거로 돌아가도 WARP receipt가 남아 있으면 동일 source ID의 재전송으로 기존 receipt를 회복할 수 있습니다. 반대로 WARP만 과거로 복원된 경우 Marketing의 delivered 표시는 원격 자료의 존재 증거가 아닙니다. 자동 dispatcher는 완료 이력을 지우거나 전체 재전송하지 않으며, 담당자 대조와 승인된 대상 복구가 필요합니다. 이 비대칭을 합성 검사에 명시합니다.
