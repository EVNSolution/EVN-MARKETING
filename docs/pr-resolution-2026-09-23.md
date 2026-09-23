# EVN-MARKETING PR #1~#12 정리 및 배포 문의 해석

기준: 2026-09-23. 검토자용 작업 기록입니다. 아직 병합·배포·비용 승인 완료 보고가 아닙니다.

## 누적 PR의 범위와 반영 순서

PR #1~#12는 독립 기능 12개가 아니라 앞선 변경 위에 다음 변경이 쌓인 순차 stack입니다. 각 PR의 차이와 최종 tree를 함께 확인합니다.

| 순서 | 대상 | 누적 작업의 주제 |
| --- | --- | --- |
| 1 | [#1](https://github.com/EVNSolution/EVN-MARKETING/pull/1) | 최초 서비스·배포 |
| 2 | [#2](https://github.com/EVNSolution/EVN-MARKETING/pull/2) | 전용 서버 계획 |
| 3 | [#3](https://github.com/EVNSolution/EVN-MARKETING/pull/3) | 준비도 수정 |
| 4 | [#4](https://github.com/EVNSolution/EVN-MARKETING/pull/4) | 운영 사전조건 |
| 5 | [#5](https://github.com/EVNSolution/EVN-MARKETING/pull/5) | readiness·drain |
| 6 | [#6](https://github.com/EVNSolution/EVN-MARKETING/pull/6) | worker fencing |
| 7 | [#7](https://github.com/EVNSolution/EVN-MARKETING/pull/7) | 웹·업로드 호환 |
| 8 | [#8](https://github.com/EVNSolution/EVN-MARKETING/pull/8) | 데이터 호환·복구 |
| 9 | [#9](https://github.com/EVNSolution/EVN-MARKETING/pull/9) | release controller·cloud |
| 10 | [#10](https://github.com/EVNSolution/EVN-MARKETING/pull/10) | 인수 시험 |
| 11 | [#11](https://github.com/EVNSolution/EVN-MARKETING/pull/11) | 백업·복구 |
| 12 | [#12](https://github.com/EVNSolution/EVN-MARKETING/pull/12) | foundation·관리자 수동 배포 |

최종 tree의 수정과 검증이 끝난 뒤, 최신 단계부터 이전 단계로 순차 통합하여 `main`에 반영합니다. 현재 이 문서는 어느 PR도 병합 완료로 기록하지 않습니다.

## 배포 문의의 의미와 결정권

- [PR #1의 작성자 댓글](https://github.com/EVNSolution/EVN-MARKETING/pull/1#issuecomment-5710796098)은 승인 범위·실행 담당·시점을 결정한 뒤 작성자가 진행한다는 뜻입니다.
- [PR #12](https://github.com/EVNSolution/EVN-MARKETING/pull/12)는 전용 서버 생성 비용과 GitHub Free에서 관리자 승인 기반 수동 배포 절차의 **채택 승인**을 요청합니다. 배포 완료 보고나 관리자에게 전체 구현을 넘기는 요청으로 해석하지 않습니다.
- PR 작성자가 제시한 서버 기본 비용은 730시간 기준 약 **USD 46.26/월**이며 백업, ECR, 트래픽, 관측, DNS, 세금 등은 별도입니다. 이번 검토에서 AWS 가격을 재조회하지 않았습니다. [PR의 비용 근거](https://github.com/EVNSolution/EVN-MARKETING/blob/ed658894eb6e9eb5f69689d83afd2f018a81ddd9/docs/cloud-release.md#L28)
- OziinG가 업무상 비용·운영 승인권자입니다. 실제 실행 담당자와 시점은 승인 범위와 함께 별도로 기록해야 합니다. 이 문서는 비용 승인이나 운영 전환 승인이 아닙니다. 소스 병합도 그 승인을 대신하지 않습니다.

## release audit 수정 및 로컬 검증

- 수정 전 release의 `npm audit --omit=dev --audit-level=high`가 high 취약점 4건으로 실패했습니다. 원인은 Prisma 도구의 전이 의존성 `deepmerge-ts`와 `mysql2`입니다.
- 해당 부모 의존성에만 `deepmerge-ts@8.0.2`, `mysql2@3.24.4` override와 PR audit gate를 추가했습니다. Prisma 직접 버전은 유지했습니다. 개발 의존성 `js-yaml`은 `4.3.2`로 lockfile만 수정했습니다. [js-yaml advisory](https://github.com/advisories/GHSA-2883-xcg3-v3hh)
- 로컬에서 clean `npm ci`, 전체 audit와 production audit 각각 exit 0·취약점 0건, Prisma generate/validate, schema·data-recovery·DB 검사와 typecheck가 통과했습니다. lint는 오류 0건·기존 경고 4건, GitHub workflow 3개의 YAML 파싱과 `git diff --check`도 통과했습니다.
- deepmerge의 `Map` 동작 변경과 Prisma config 호환성은 수정 영향 검토 항목입니다. 참고 advisory: [deepmerge recursion](https://github.com/advisories/GHSA-ggr8-5vv4-36mx), [mysql2 auth downgrade](https://github.com/advisories/GHSA-3f6p-5ww8-9rcr), [mysql2 decompression](https://github.com/advisories/GHSA-rgwj-5xj2-c3m3).

## 현재 증거의 경계

| 구분 | 현재 기록 |
| --- | --- |
| 소스·CI | [PR #12 head `ed658894`](https://github.com/EVNSolution/EVN-MARKETING/pull/12)의 [Linux CI](https://github.com/EVNSolution/EVN-MARKETING/actions/runs/35795923864)는 성공했습니다. 이번 audit 수정이 반영된 새 Linux CI는 아직 대기 중입니다. 기존 CI는 최종 통합 tree나 운영 호스트 검증이 아닙니다. |
| AWS | PR 작성자는 foundation CREATE changeset이 `AVAILABLE`이지만 미실행이고 EIP 한도가 8로 적용됐다고 기록했습니다. 이번 검토에서는 AWS를 재조회하지 않았습니다. [PR #12 본문](https://github.com/EVNSolution/EVN-MARKETING/pull/12), [문서의 당시 상태](https://github.com/EVNSolution/EVN-MARKETING/blob/ed658894eb6e9eb5f69689d83afd2f018a81ddd9/docs/cloud-release.md#L23-L24) |
| 미완료 | 초기 호스트 설치, 이미지 발행, HTTPS, 실제 데이터 이전, 백업 복원, 재부팅, 단일 수집기·전송 운영 검증은 완료 증거가 없습니다. [설치·전환의 분리](https://github.com/EVNSolution/EVN-MARKETING/blob/ed658894eb6e9eb5f69689d83afd2f018a81ddd9/docs/cloud-release.md#L17-L17), [미실행 범위](https://github.com/EVNSolution/EVN-MARKETING/blob/ed658894eb6e9eb5f69689d83afd2f018a81ddd9/docs/cloud-release.md#L48) |

GitHub 배포 역할을 만드는 `EnableGitHubRelease`는 `false`로 유지하고, 외부 문의 수신용 `LEADS_INTAKE_API_KEY`는 설정하지 않습니다. [수동 경로](https://github.com/EVNSolution/EVN-MARKETING/blob/ed658894eb6e9eb5f69689d83afd2f018a81ddd9/docs/cloud-release.md#L32-L32), [운영 계획](https://github.com/EVNSolution/EVN-MARKETING/blob/ed658894eb6e9eb5f69689d83afd2f018a81ddd9/docs/production-deployment.md#L44)

기존 R6 영구 오류 재시도와 R10 worker에 불필요한 `AUTH_SECRET` 주입은 각각 별도 후속 항목으로 남아 있습니다. 이 문서는 그 후속 조치를 완료했다고 주장하지 않습니다.
