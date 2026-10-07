# 홈페이지 문의 DB 확장을 위한 선행 호환 릴리스

이 변경은 기존 앱과 DB schema를 그대로 두고, 검토 대상으로 고정한 홈페이지 문의 확장에 대한 읽기 전용 검사·복구 호환성을 추가한다. 홈페이지 공개, 상담 접수 활성화, DB migration 실행은 하지 않는다. 보안 검사에서 차단된 sharp는 0.35.5 및 대응 libvips 패키지로 갱신한다. 근거: https://github.com/lovell/sharp/security/advisories/GHSA-wq5f-xc86-pv6w

## 고정된 계약

- 기존 schema 출처: `7dae895c9b1f3a21cb17f0a918b58c729a87601b`
- 확장 schema 출처: PR #28의 `d7d59c565a4f30982b6fffcd729ee1aae83f96c4`
- 기존 계약 SHA-256: `be0bbaab3f91511d72fca7dd533179bbf9e54d25bd9ce8c215ce128db9e23ae6`
- 확장 계약 SHA-256: `ce708b8e46cf000c4058ca7163ab54a2bde00b3fa675d950961463ee514bca26`

계약 hash는 순서가 고정된 `prismaSchemaSha256`, `migrations`, `schema` JSON의 SHA-256이다. policy 파일은 두 커밋의 Git blob 원본으로 생성했다. Windows 체크아웃의 CRLF 변환을 승인된 Linux 계약으로 오인하지 않는다. 이미지에 들어가는 manifest는 Linux 빌드 소스의 정확한 bytes로 생성한다.

추가 허용 대상은 `LandingReceipt`, `LandingThrottle` 테이블 및 대응 인덱스 두 개뿐이다. 기존 DDL, 전체 migration 목록·checksum, Prisma schema hash 중 하나라도 고정된 값과 다르면 이 확장 경로를 사용할 수 없다. 임의의 ‘추가만 하는 migration’을 일반적으로 허용하지 않는다.

## 복구 경계

두 이미지의 manifest 모두 정확한 확장 계약에 대한 `schemaCompatibility.landingExpansion`을 포함해야 서로 다른 계약을 연결할 수 있다. 원래 운영 이미지에는 이 표시가 없으므로 홈페이지 기능을 곧바로 배포하거나 확장 후 원래 이미지로 rollback하는 조합은 거부한다. 이 선행 이미지의 자기 검사·복구는 확장 전과 후 DB 모두를 검증한다. 기능 이미지도 같은 검사 모듈과 policy를 포함해야 한다.

검사는 여전히 DB 읽기 전용이다. 정확한 DDL, migration 이력의 완료·checksum·중복, integrity 및 foreign key 검사는 유지한다. migration을 자동 실행하거나 이력을 수정하지 않는다.

## 운영 순서와 아직 남은 작업

1. 이 선행 변경을 Linux CI/Docker/기존 복원·두 버전 브라우저·controller 검사까지 통과시킨 뒤 검토한다. 운영 schema가 기존 계약과 일치하는지 확인한다.
2. 기존 승인된 release 절차와 백업·복원 증거를 사용해 **DB 변경 없이** 이 선행 이미지를 먼저 배포한다. 정확한 commit과 image digest를 기록한다. 관찰 시간과 이전 proxy 연결 drain을 완료한다.
3. PR #28에 이 검사 모듈을 적용하고 실제 선행 commit을 두 버전 호환성 검사의 비교 대상으로 고정한다. 홈페이지 기능 이미지·operations 이미지의 출처와 계약을 검증한다.
4. 별도 복원본에서 정식 Prisma migration 실행, 기존 테이블·업로드 보존, 구버전 앱 읽기/쓰기, 기능 앱 접수, 양방향 복구를 검증한다. **이 문서와 읽기 전용 checker만으로 이 리허설을 완료했다고 간주하지 않는다.**
5. 운영 확장은 동일 host lock, 검증된 일관 백업, 모든 writer 중지, 완료 이력·정확한 계약 검증, 중단 시 재개 규칙을 갖춘 별도 절차로 준비한다. 현재 `data-ops.py migrate-check`는 동일 schema의 복원본만 허용하므로 그대로 이 확장에 사용하지 않는다. 운영 `db push`, seed, 임의 ledger 삽입/수정은 금지한다.
6. 기존 사용자 조건에 따라 새로운 sudo/root 작업 및 중지 단계는 구체적인 실행 계획을 확정한 뒤 승인을 받는다. 그 전에는 운영에 적용하지 않는다.
7. 확장 완료 후에도 접수 비활성 상태에서 기능 후보를 검증하고, 최종적으로 접수 활성화·실제 Inquiry 저장·관리자 목록 표시를 확인한다. 공개 완료는 그 이후다.

## 검증 범위

`tests/landing-schema-bridge.test.mjs`는 합성 DB로 선행 릴리스/복구, 양방향 기능 전환, 준비되지 않은 이미지 거부, 예상 외 DDL·이력·무결성 변경 거부, 검사 시 무수정 및 기존 테이블 쓰기를 검증한다. 기존 `test:schema`에도 연결했다. 실제 Linux 이미지 간 브라우저·controller·정식 migration 리허설은 별도 필수 검사이며 이 단위 검사의 대체물이 아니다.
