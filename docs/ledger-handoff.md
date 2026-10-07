# 거래 원장(Transaction Ledger) — 인수인계

새 세션에서 이 문서만 읽고 바로 이어받을 수 있도록 쓴 상태 기록이다.

**거래 원장은 production 에 적재·배포까지 끝났다.** migration 004 적용, 463건 import,
멱등성 검증, 모바일 읽기 UI 검증이 모두 완료됐다. 상세는 §2 와 §9.

**남은 것은 두 가지뿐이고 둘 다 보류 상태다:**

1. **거래 이력 write smoke test (§9 의 B~F)** — memo / tag / 숨김 / 정정 / 분리·이동.
   아직 하지 않았다. 숨김·복원만 우연히 검증됐다(§2 참고).
2. **legacy consumer 전환 (§9 J)** — 아직 시작하지 않았다.

> **다음 우선 작업은 이 둘이 아니다.** 작업 우선순위가 **"대시보드 기간 성과 →
> 수익 분석 개편"** 으로 옮겨갔다. 거래 원장 쪽은 위 두 항목을 남겨둔 채 **안정된
> 상태로 멈춰 있다** — production 데이터와 배포는 정상이므로 그대로 두면 된다.
> 나중에 이어받을 때 §9 의 B 단계부터 보면 된다.

- 브랜치: `feat/historical-performance-reconstruction`
- 저장소 루트: `k-allweather/app/` (git 명령은 반드시 여기서)
- 이 문서를 만든 커밋: `e8bbc2c`

---

## 1. 완료된 Phase

| Phase | 내용 | 커밋 |
|---|---|---|
| 1 | migration 004 설계 (신규 테이블 6종 + 롤백 + 검증 쿼리) | `34a9cb6` |
| 2 | verified dataset 반입 / 순수 도메인 모델 / 적재 전 게이트 | `34a9cb6` |
| 3 | fingerprint · provenance / dry-run import / Worker API / 읽기 훅 | `0c10eaf` |
| 4 | 거래 이력 UI (목록·필터·상세·편집·정정·audit·반응형) | `ccea87b` |
| — | 이 인수인계 문서 | `e8bbc2c` |
| 5 | migration 004 권한 교체(전부 회수 후 재부여) + CHECK 2종 | `a434682` |
| 5 | batch 기록 실패를 드러내고 복구 가능하게 / 쓰기 경로 분리 | `f9e1a0b` |
| 5 | `process.exit` → `exitCode` (종료코드가 127 로 덮이던 문제) | `7b60a02` |
| 5 | 긴급 batch 롤백 절차 + 적재 후 검증 스크립트 | `3e2cad6` |
| 6 | **`compareIntraDayOrder` 를 유효한 전순서로** (입력 순서 의존 버그) | `f8ad88b` |
| 6 | production import 완료 반영 | `1c85df2` |
| 7 | `buyCount`/`sellCount` 를 체결 건수 → **종목 수**로 | `acf347a` |
| 7 | 모바일 상세 뒤로가기 / 다이얼로그 X 가림 수정 | `309523f` |
| 7 | 모바일 목록 진입 화살표 제거 | `f6c2a66` |

Phase 1 과 2 는 한 커밋에 함께 들어갔다(스키마와 그 스키마를 쓰는 도메인 모델을
따로 커밋하면 중간 상태가 컴파일되지 않는다).

Phase 5~7 은 production 적용 과정에서 나온 수정이다. 특히 6 은 **적재 후 검증에서
드러난 실제 버그**였다 — 자세한 내용은 §5.

### 이 작업 직전의 선행 커밋 (참고)

| 커밋 | 내용 |
|---|---|
| `5d9e6ff` | 일별 스냅샷 이전 과거 구간 복원 (보유수량 × 당시 종가) |
| `66385de` | 실제 증권사 자료로 확정한 과거 cashflow 를 canonical seed 로 고정 |

`66385de` 의 cashflow 체크섬(151,855,018)과 이 원장의 체크섬이 일치하는 것이
테스트로 묶여 있다.

---

## 2. 현재 production 상태

**적재·배포 완료 (2026-10-07).**

| 항목 | 상태 |
|---|---|
| migration 004 | **적용됨** (사용자가 SQL Editor 에서 실행, 검증 쿼리 통과) |
| `kaw_transaction_ledger` | **463건 적재됨** |
| 기본 grouping event | **65** |
| negative holding | **0** |
| postQuantity mismatch | **0** (대조 가능 171건) |
| finalHoldings | 데이터셋과 **완전 일치** |
| `fingerprint_version` | `1` 단일 |
| orphan / null `import_batch_id` | **0 / 0** |
| production 배포 | **정상** — `https://portfolio.hyeobi.workers.dev` |

### import batch 이력

```
2026-10-07T04:47:36Z  inserted 463 / skipped   0  imp:verified_dataset_v1:2026-10-07T04:47:35.189Z
2026-10-07T06:29:48Z  inserted   0 / skipped 463  imp:verified_dataset_v1:2026-10-07T06:29:47.300Z
```

2차 import 로 **멱등성 검증 완료** — 전체 건수 463 유지, 기존 463행의 `import_batch_id`
는 최초 batch 그대로다. 2차 batch 를 가리키는 거래는 0건이고, 그것이 정상이다
(재실행 이력일 뿐이다).

### overlay 현황 (write test 전 기준선이 아니다)

```
kaw_transaction_correction       0
kaw_transaction_event_override   0
kaw_rebalance_event              1   ← rev:pension:2026-08-28 (no-op 행)
kaw_ledger_audit                 3
```

사용자가 2026-10-07 12:02 에 모바일에서 `2026-08-28 연금저축` 이벤트를 **숨겼다가
복원**하면서 생긴 것이다. audit 3건(`event_hide` ×2 / `event_restore`)이 append-only
로 남아 있고, `rebalance_event` 행은 `memo: null, tags: [], hidden: false` 인 **무해한
no-op** 이다(기본 grouping 과 동일한 상태라 화면에 영향이 없다).

**결과적으로 §9 D단계(숨김/복원)는 실제 production 에서 정상 동작이 확인된 셈이다** —
행이 생기고, 플래그가 토글되고, 복원되고, audit 가 남았다. 원장은 그대로다.
이 행을 지울지는 정하지 않았다. 남겨도 무방하고, 다른 이벤트로 테스트하면 간섭이 없다.

### legacy 는 그대로다

legacy `kaw_data.data -> 'history'` 와 그것을 읽는 모듈은 **전부 그대로**다.
이번 작업에서 한 줄도 바꾸지 않았다:
`snapshot.ts`, `kaw_portfolio_live_view`, `historical-performance.ts`,
`benchmark-series.ts`, `backtest.ts`, `AccountPage` 히스토리 탭, `Dashboard`,
migrations 001-003.

### 손대지 않는 로컬 작업물

작업 트리에 사용자의 기존 작업이 남아 있다. **수정·stage·삭제하지 않는다.**

```
 M scripts/verify-cashflow-principal.ts
?? .claude/
?? scripts/fix-2026-09-25-cashflows.ts
?? scripts/verify-carry-forward.ts
?? scripts/verify-snapshots-table.mjs
```

---

## 3. 검증된 데이터 기준

`data/verified-transactions.v1.json` (미래에셋 공식 매매내역/거래내역 정규화본).
아래 값은 `npm run ledger:dry-run` 과 테스트가 매번 확인한다.

| 항목 | 값 |
|---|---|
| transaction | **463** |
| event (기본 grouping) | **65** |
| retirement | 거래 227 / 이벤트 27 |
| pension | 거래 86 / 이벤트 13 |
| ISA | 거래 85 / 이벤트 16 |
| IRP | 거래 65 / 이벤트 9 |
| duplicate fingerprint | **0** |
| negative holding | **0** |
| postQuantity mismatch | **0** (대조 가능 171건) |
| finalHoldings | **완전 일치** |
| cashflow checksum | **151,855,018** |

기간은 2025-05-14 ~ 2026-10-01. 거래일 근거 분포는
`broker-order-date` 292 / `cross-account-settlement-match` 110 /
`tplus2-weekday-inference` 61 이다.

---

## 4. 바꾸면 안 되는 데이터 규칙

1. **실제 체결내역이 historical transaction 의 source of truth 다.**
2. **과거 목표비중으로 거래를 추론하지 않는다.** 스키마에도 도메인 모델에도
   목표비중 필드가 없다. "당시 목표가 40%였으므로 이렇게 리밸런싱했을 것"이라는
   계산 경로를 만들지 않는다.
3. **`kaw_transaction_ledger` 는 immutable.** 단 그 범위는 **`service_role`**이다 —
   migration 004 가 service_role 에서 UPDATE/DELETE/TRUNCATE 를 회수한다(단순히
   grant 하지 않는 것으로는 부족하다). 따라서 앱·Worker·스크립트 경로에서는
   원본을 바꾸거나 지울 수 없다. 적재는 `scripts/ledger-import.ts` 로만 한다.

   **owner(`postgres`)는 예외다.** SQL Editor 에서는 지울 수 있고, 그것을 권한으로
   막을 방법도 없다(소유자니까). 즉 **"적재하면 테이블 drop 외에는 되돌릴 수
   없다"는 틀린 말이다.** import batch 단위로 정확히 되돌리는 비상 절차가
   `docs/ledger-emergency-rollback.md` 에 있다(관리자 전용, 평상시 사용 금지).
   그 문서가 cascade 로 함께 사라지는 overlay 까지 포함해 설명한다.

4. **거래 정정은 overlay** (`kaw_transaction_correction`). 유효값 = `corrected_* ?? 원본`.
   제외도 삭제가 아니라 `excluded` 플래그다.
5. **소속 이벤트 변경도 overlay** (`kaw_transaction_event_override`). 병합/분리/이동이
   전부 이것 하나로 표현되고, 행을 지우면 기본 grouping 으로 되돌아간다.
6. **audit 는 append-only.** service_role 에서 UPDATE/DELETE/TRUNCATE 를 회수한다.
7. **파생값을 DB 에 중복 저장하지 않는다.** 거래건수·매수/매도 금액·전후 보유수량은
   소속 거래가 바뀌면 즉시 달라지므로 `ledger.ts resolveEvents` 가 계산한다.
8. **fingerprint version 은 v1.** 문자열 맨 앞에도 들어간다(`v1|...`).
   KIS API 등 다른 source 는 **별도 버전(v2 …)으로 확장**한다 — KIS 는 주문번호/
   체결번호를 주므로 내용 조합 대신 그 번호로 신원을 잡는 편이 정확하다.
   규칙을 바꿀 때는 ① 새 버전 함수 추가 + `FINGERPRINT_VERSION` 상향,
   ② 기존 행 재계산 마이그레이션, ③ 한 profile 안에 두 버전을 섞지 않기.

### fingerprint 가 내용 기반인 이유 (실측)

`source_row` 를 신원으로 쓸 수 없다. 미래에셋 export 는 둘 다 **최신순**이라
(DC 매매내역 `row 4` = 2026-10-01, `row 456` = 2025-05-14) 거래가 하나 추가되면
기존 행 번호가 전부 밀린다. 재export 하면 같은 체결이 다른 번호를 받는다.
사용자가 보완한 10행은 `source_row` 가 아예 없다.

그래서 v1 규칙은
`v1 | source | 계좌 | 종목 | 매매구분 | 수량 | 단가 | 금액 | 거래일 | 결제일 | 동일건순번`
이다. **동일건순번**이 필요한 이유도 실측이다 — IRP 에 내용이 완전히 같은 분할체결이
있다(2026-03-25 `0072R0` 1주 2건, 2026-08-28 `438080` 1주 3건). 순번이 없으면
5건이 2건으로 뭉개진다.

---

## 5. source 별 일중(日中) 거래 순서 규칙 — **절대 바꾸지 말 것**

`src/lib/kaw/ledger.ts` 의 `INTRA_DAY_ROW_ORDER`.

| source | 방향 | 근거 |
|---|---|---|
| `miraeasset_transaction_history` (ISA·연금) | `sourceRow` **내림차순** | 거래후잔고 171건 전부 일치. 오름차순이면 51건 불일치 |
| `miraeasset_retirement_web` (퇴직연금·IRP) | `sourceRow` **오름차순** | 거래후잔고가 없어 "음수 보유수량 불가"로 판별 |

증권사는 체결 시각을 주지 않아 원본 엑셀 행 번호가 유일한 단서인데, **두 export 의
하루 안 방향이 반대**다. 네 조합을 전수 비교해 음수 0건 + 불일치 0/171 인 조합만
채택했다.

**이 규칙을 바꾸면 `postQuantity` 대조와 holdings replay 가 깨진다.**

> **2026-10-07 추가 — 비교자는 반드시 유효한 전순서여야 한다.**
> 위 방향 규칙은 그대로지만, 구현이 행 번호를 **계좌 구분 없이** 비교해
> 전이성이 깨져 있었다(위반 삼각형 17,190개). `Array.sort` 는 그럴 때
> 입력 순서에 따라 다른 결과를 내므로, 파일 순서만 우연히 맞았고 DB
> 조회 순서로는 postQuantity 불일치 12건이 나왔다. `f8ad88b` 에서 사전식
> 전순서(accountId → source → 방향 적용된 sourceRow → id)로 고쳤다.
> 새 source 를 추가할 때도 **파일 순서 하나로만 검증하지 말고**
> `ledger-order.test.ts` 의 여러 입력 순서를 통과하는지 확인한다. 구체적으로,
retirement 를 내림차순으로 돌리면 `484790` 이 2026-05-26 에 **-723주**가 된다
(그 날 매수 689+34 와 매도 1381 의 순서가 뒤집히기 때문). 오름차순이면
658 → 692 → 1381 → 0 으로 이어진다.

새 source 를 추가할 때는 반드시 같은 방식으로 방향을 실측한다. 기본값 `"asc"` 는
검증된 값이 아니라 "파일을 위에서 아래로 읽는 자연스러운 순서"일 뿐이다.
`verifyDataset` 이 두 검사(거래후잔고 대조 / 음수 보유수량)를 모두 한다.

---

## 6. 신규 DB 구조 (migration 004 — **적용 완료**)

| 테이블 | 역할 |
|---|---|
| `kaw_ledger_import_batch` | 적재 묶음. 출처(`source_kind`/`source_label`/`checksum`), inserted/skipped 건수, 적재 전 게이트 결과 전문, actor. Excel·KIS API·수동 보정이 같은 원장에 들어오므로 묶음 단위로 추적한다 |
| `kaw_transaction_ledger` | **개별 실제 체결 (원본).** immutable. `source_fingerprint` 에 `UNIQUE (family_code, profile, source_fingerprint)` 가 걸려 중복 적재를 DB 레벨에서 막는다 |
| `kaw_transaction_correction` | 사용자 거래정보 정정 overlay. 원본을 덮지 않는다. `excluded` 는 계산 제외 플래그(삭제 아님) |
| `kaw_transaction_event_override` | 소속 이벤트 재지정. 병합·분리·이동이 전부 이것으로 표현된다. 행을 지우면 기본 grouping 복귀 |
| `kaw_rebalance_event` | 사용자 의미정보만 — 메모·태그·숨김·유형·`strategy_included`·`is_user_created`. 기본 grouping 이벤트는 행이 없어도 된다 |
| `kaw_ledger_audit` | append-only 변경 이력. UI 분류 수정(`event_merge`/`event_split`/`tx_move`/`memo_change`/`tag_change`/`event_hide`/`event_restore`)과 거래정보 정정(`tx_correct`/`tx_uncorrect`)을 `action` 으로 구분 |

### 권한 모델 (001~003 과 다른 부분)

RLS on + 정책 0개, 브라우저는 Worker 의 `/api/*` 만 쓴다 — 여기까지는 001/002/003 과 같다.
**다른 것은 GRANT 를 거는 방식이다.**

Supabase 는 `public` 스키마에 기본 권한이 걸려 있어서
(`alter default privileges in schema public grant all on tables to postgres, anon,
authenticated, service_role`) **새 테이블은 생성되는 순간 `service_role` 에도 `ALL` 이
붙는다.** GRANT 는 가산이라 "필요한 것만 grant" 는 빼기가 되지 않는다. 001~003 처럼
`anon`/`authenticated` 만 회수하면 `service_role` 은 UPDATE/DELETE/TRUNCATE 를 그대로
갖고, 그러면 **원장 immutable 도 audit append-only 도 전혀 성립하지 않는다.**

그래서 004 는 신규 6개 테이블에 대해 **PUBLIC / anon / authenticated / service_role 의
권한을 먼저 전부 회수한 뒤 `service_role` 에 필요한 것만 다시 부여한다.**

| 테이블 | service_role | 금지 |
|---|---|---|
| `kaw_transaction_ledger` | SELECT, INSERT | UPDATE / DELETE / TRUNCATE / REFERENCES / TRIGGER |
| `kaw_ledger_audit` | SELECT, INSERT | UPDATE / DELETE / TRUNCATE / REFERENCES / TRIGGER |
| `kaw_ledger_import_batch` | SELECT, INSERT | UPDATE / DELETE / TRUNCATE / REFERENCES / TRIGGER |
| `kaw_transaction_correction` | SELECT, INSERT, UPDATE, DELETE | TRUNCATE / REFERENCES / TRIGGER |
| `kaw_transaction_event_override` | SELECT, INSERT, UPDATE, DELETE | TRUNCATE / REFERENCES / TRIGGER |
| `kaw_rebalance_event` | SELECT, INSERT, UPDATE, DELETE | TRUNCATE / REFERENCES / TRIGGER |

PUBLIC / `anon` / `authenticated` 에는 아무 권한도 주지 않는다.
**owner(`postgres`)는 건드리지 않는다** — 여기서 말하는 immutable / append-only 는
"Worker 가 쓰는 `service_role` 키로는 원장과 audit 을 바꾸거나 지울 수 없다"는 뜻이고,
SQL Editor 의 소유자 권한까지 막으려는 것이 아니다(소유자는 어차피 막을 수 없다).

`kaw_ledger_audit.id` 는 identity 다. **identity 시퀀스에는 별도 GRANT 를 주지 않는다** —
identity 컬럼의 시퀀스는 컬럼에 internal dependency 로 묶여 있어 `nextval` 이 권한 검사를
거치지 않는다(`serial` 과 다르다). 004 의 smoke test (j) 가 시퀀스 권한을 전부 회수한
트랜잭션 안에서 실제 INSERT 로 이것을 확인하고, 실패할 때만 `usage` 를 추가한다.

### DB 레벨 CHECK 2종

- `kaw_transaction_ledger_fp_version_chk` — `source_fingerprint` 가 자기
  `fingerprint_version` 과 맞는 prefix(`v<n>|…`)를 갖도록 강제한다. 둘이 어긋나면
  "한 profile 에 두 버전을 섞지 않는다"는 규칙을 검증 쿼리 (f-2) 로도 못 잡는다.
- `kaw_transaction_correction_nonempty_chk` — 정정 6필드가 전부 null 이고 `excluded` 도
  false 인 행을 막는다. 유효값 규칙이 `corrected_* ?? 원본` 이라 **"null 로 정정"을
  표현할 방법이 애초에 없으므로** 그런 행은 아무 값도 안 바꾸면서 그 거래를 "사용자 정정
  데이터"로 잘못 배지하기만 한다. 원본 복귀는 행 삭제(`clear: true`)다.
  `handleLedgerCorrectPost` 가 같은 조건을 먼저 검사해 400 으로 돌려준다.

기본 grouping: **동일 계좌 + 동일 실효 거래일** → `rev:<account>:<date>` (계산 가능).

롤백: `migrations/004_transaction_ledger_rollback.sql` (백업 쿼리를 먼저 실행하도록
안내가 들어 있고, 003 이 쓰는 `kaw_touch_updated_at()` 는 지우지 않는다).

---

## 7. 신규 거래 이력 UI

Sidebar 전역 메뉴 **"거래 이력"** (`Page = "ledger"`). 기본 단위는 개별 체결이 아니라
Rebalance Event. **계좌 화면의 legacy 히스토리 탭은 그대로 두었다.**

- **목록** — 거래일 / 계좌 / 유형 / 매수·매도 종목 수 / 매수·매도 금액 / 주요 종목 /
  메모 / 태그 / 숨김·수정·정정·날짜추정 배지
- **검색·필터** — 기간, 계좌, 매수/매도, 유형, 태그, 검색(종목명·종목코드·메모·태그),
  숨김 포함. 겹쳐 쓸 수 있고 선택지는 실제 데이터에 있는 값만
- **상세** — 체결마다 **이전 보유수량 → 매매수량 → 이후 보유수량**, 그리고 종목명·
  코드·매매구분·체결수량·단가·거래금액·수수료·세금·거래일·결제일·source·거래후잔고.
  **증권사가 주지 않은 값은 `—` 이고 0 으로 채우지 않는다.** 거래일에 확정/추정 라벨
- **편집** — 메모 / 태그 / 유형 / 숨김·복원 / 병합 / 분리 / 이동 / 자동 분류로 되돌리기.
  사용자는 DB 구조를 몰라도 된다 (목록에서 여러 이벤트 체크 → 병합, 상세에서 거래
  체크 → 분리·이동)
- **정정** — 원본과 나란히 보여주고 "원본 복귀" 가능. 수량·단가만 고치면 금액 재계산
- **audit** — 상세의 "변경 이력"
- **상태 구분** — loading / error / unavailable(migration 미적용) / empty(적재 전) /
  결과 없음(필터)
- **반응형** — 데스크톱 표, 모바일(375px) 카드. 가로 스크롤 없음

관련 파일:
`src/components/kaw/LedgerPage.tsx`, `LedgerEventDetail.tsx`,
`src/lib/kaw/ledger.ts`(도메인), `ledger-ui.ts`(표시 규칙),
`useLedger.ts`(훅), `ledger-server.ts`(Worker API),
`verified-transactions.ts`(파서·게이트),
`ledger-import-core.ts`(적재 쓰기 경로) + `scripts/ledger-import.ts`(CLI).

### production 적용 후 고친 UI 문제 (2026-10-07)

| 문제 | 수정 | 커밋 |
|---|---|---|
| `buyCount`/`sellCount` 가 체결 건수인데 화면은 "매수 N**종목**"으로 표시 | 값을 distinct ticker 수로 변경. `tradeCount` 는 체결 건수 유지 | `acf347a` |
| 상세 닫기가 불명확 — 공용 `DialogClose` 에 z-index 가 없어 sticky 헤더(z-10) 뒤로 숨고, `absolute` 라 스크롤하면 뷰포트 밖으로 사라짐 | sticky 헤더에 모바일 전용 `← 거래 이력` 추가(탭 영역 36px), 헤더에 `pr-12`, 공용 `DialogClose` 에 `z-20` | `309523f` |
| 모바일 목록의 진입 화살표가 화면 끝에 붙어 잘려 보임 | 제거. 카드 전체가 이미 탭 대상이라 중복 UI 였다. 데스크톱 표의 화살표는 유지 | `f6c2a66` |

`buyCount` 가 틀렸던 실측 예(수정 전 → 후): 2026-08-28 퇴직연금 매수 **14 → 5**,
IRP 매수 5 → 2 / 매도 3 → 3, 2026-06-26 ISA 매수 5 → 2.
`verified-transactions.test.ts` 가 이 세 값을 고정값으로 들고 있다.

**데스크톱에 남은 문제(별건, 미수정):** 본문을 길게 스크롤하면 공용 X 가 같이 밀려
사라진다. Esc 와 바깥 클릭은 동작한다. 고치려면 X 를 sticky 헤더 안으로 옮기면 된다.

### import 쓰기 흐름과 partial failure

적재는 **두 번의 Supabase 요청**이고 **그 사이에 트랜잭션이 없다.** PostgREST 는
요청 1건 = 트랜잭션 1건이다.

```
(1) kaw_transaction_ledger  upsert 463행   ← 단일 INSERT 문이라 all-or-nothing
      on conflict (family_code, profile, source_fingerprint) do nothing
      RETURNING 은 실제로 삽입된 행만 → 그 개수가 inserted
(2) kaw_ledger_import_batch insert 1행     ← **완성된 provenance 를 한 번만** INSERT
```

`import_batch_id` 에는 **FK 가 없다**(provenance 참조일 뿐 무결성 제약이 아니다).
그래서 원장을 먼저 넣어도 참조 위반이 나지 않는다.

(2) 를 먼저 넣지 않는 이유는 `inserted`/`skipped` 가 (1) 의 결과라서다. 먼저 넣으려면
나중에 UPDATE 해야 하는데 `kaw_ledger_import_batch` 는 service_role 에 select/insert
만 있다. **지금 순서가 권한 모델과 맞는 유일한 순서이고, 적재 경로 전체에 UPDATE 가
한 번도 없다.**

| 상황 | 동작 |
|---|---|
| 최초 import | inserted 463 / skipped 0, batch 행 1개 |
| 동일 dataset 재import | inserted 0 / skipped 463, batch 행이 **하나 더** 생긴다(실행 이력) |
| (1) 실패 | batch 를 쓰지 않고 중단. 463행은 all-or-nothing 이라 일부만 남지 않는다. 단 **타임아웃이면 서버가 커밋했을 수 있어** 재실행 전에 dry-run 으로 행 수를 확인하라고 출력한다. fingerprint UNIQUE 때문에 재실행해도 중복은 안 생긴다 |
| (1) 성공 + (2) 실패 | 3회 재시도 후 **throw 하고 비정상 종료한다.** 조용히 "적재 완료"로 끝나지 않는다 |

**(1) 성공 + (2) 실패가 유일하게 위험한 상태다.** 원장 463행의 `import_batch_id` 가
없는 batch 를 가리키고, 원장은 immutable 이라 그 컬럼을 고칠 수 없다. **그냥 재실행하면
새 batch id 가 생겨 끊긴 참조가 영구히 남는다.** 그래서 스크립트는 그 경우
**같은 id 로 넣을 `INSERT` 문을 그대로 출력**한다 — SQL Editor 에 붙여넣으면 복구된다
(service_role INSERT 한 번이면 되므로 immutable 원칙을 깨지 않는다).

재시도 안전성: 원장은 fingerprint UNIQUE 덕에 몇 번을 재실행해도 중복이 생기지 않는다.
batch 는 실행마다 새 id(타임스탬프)라 행이 늘지만, 그것이 곧 실행 이력이라 해롭지 않다.

쓰기 경로는 `src/lib/kaw/ledger-import-core.ts` 에 있고(스크립트는 인자 파싱·검증·리포트
담당), `src/lib/kaw/ledger-import.test.ts` 가 가짜 Supabase 클라이언트로 고정한다
(실제 463건 데이터셋 사용, update/delete 호출이 하나라도 있으면 실패).

### API

| 엔드포인트 | 역할 |
|---|---|
| `GET /api/ledger` | 원장 + overlay 전체 (4테이블 병렬) |
| `GET /api/ledger/audit` | 변경 이력 (`?targetId=`) |
| `POST /api/ledger/event` | 메모·태그·숨김·유형 |
| `POST /api/ledger/assign` | 병합·분리·이동 (`eventId: null` → 기본 복귀) |
| `POST /api/ledger/correct` | 정정 (`clear: true` → 원본 복귀) |

전부 기존 `/api/data`·`/api/snapshots` 와 같은 세션 토큰 인증(`requireSession`).
원장 테이블에는 `select` 만 있다.

---

## 8. 의도적으로 남긴 항목

production import 의 blocker 가 아니므로 **지금 구현하지 않는다.**

1. **Transaction 단위 audit UI** — API(`?targetId=`)는 있고 이벤트 단위 조회만 UI 에
   붙어 있다. 거래 정정 이력도 그 이벤트 audit 에 함께 보인다.
2. **과거 시점 평가금액 UI 연결** — `ledger.ts valuateHoldings()` 는 구현·테스트가
   끝났지만 화면에 붙이지 않았다(과거 종가 조회 연결이 필요). 보유수량 변화는 표시된다.
3. **실제 production write 동작 검증** — dev 서버에 Cloudflare `env` 가 전달되지 않아
   (`handleAuthFamily` 에서 `SUPABASE_URL` undefined — 기존 dev 한계, 이번 작업과 무관)
   로그인·API 가 동작하지 않는다. UI 는 임시 미리보기 라우트 + fixture 로 검증한 뒤
   그 라우트를 삭제했다. **저장·병합·정정의 실제 동작은 migration 적용 후 육안 검증이
   필요하다.**

---

## 9. 다음 세션에서 진행할 정확한 순서

```
A. migration 004 최종 리뷰  ✅ 완료
   차단 이슈 1건을 찾아 004 에 반영했다 — Supabase 가 public 스키마 기본 권한으로 새
   테이블에 ALL 을 붙이기 때문에, "필요한 것만 grant" 로는 service_role 의 UPDATE/DELETE/
   TRUNCATE 가 그대로 남아 원장 immutable 과 audit append-only 가 성립하지 않았다.
   권한을 "네 주체 전부 회수 → service_role 에 필요한 것만 재부여"로 바꾸고,
   CHECK 2종(fp_version / correction_nonempty)과 실효 권한 검증·smoke test 를 추가했다.
   재발 방지로 src/lib/kaw/ledger-migration.test.ts 가 004 의 권한 패턴을 고정한다.

B. 사용자에게 적용 안내
   Supabase 대시보드 → SQL Editor 에 004 전체를 붙여넣고 Run.
   (001 → 002 → 003 → 004 순서. idempotent. 기존 객체는 건드리지 않는다.)
   **이 단계는 사용자가 직접 한다.**

C. migration 적용 후 실제 DB 대상 dry-run  ✅ 완료 (2026-10-07)
   npm run ledger:dry-run -- --family=soye --profile=hyeobi
   게이트 17개 전부 통과 / DB 기존 행 0건 — 즉 004 가 적용됐고
   원장은 비어 있다. 읽기만 했다.

D. DB schema / constraint / 권한 검증  ✅ 완료 (사용자 직접 수행)
   004 파일 하단 주석의 검증 쿼리를 실행한다.
   적용 직후: (a) 테이블 6개 / (a-2) 컬럼 수 80 / (a-3) RLS on·정책 0 /
             (a-4) CHECK 2종 / (b) 선언된 GRANT / (b-2) 실효 권한 /
             (b-3) immutable 3종 0행 / (b-4) anon·authenticated 0행 /
             (j) service_role INSERT smoke test (rollback) / (k) 실패해야 정상인 probe
   import 후:  (c)~(h) 계좌별 건수 / 보유수량 재생 / 이벤트 수 / fingerprint 중복 0 /
             fingerprint_version 단일 / 배치 이력 / 날짜 근거 분포.

   **(b-3) 이 0행이 아니면 import 를 진행하지 않는다.**

E. reconciliation 재실행  ✅ 완료
   npm test (ledger / verified-transactions 테스트 포함)
   dry-run 리포트의 finalHoldings·checksum 재확인.

F. 모든 gate 통과 확인  ✅ 완료 (tsc / build / test 590건)
   npx tsc --noEmit / npm run build / npm test

G. 463건 production import  ✅ 완료 (2026-10-07)
   batch  imp:verified_dataset_v1:2026-10-07T04:47:35.189Z
   inserted 463 / skipped 0

H. import 후 재검증  ✅ 완료 — 24항목 전부 통과
   npm run ledger:verify -- --family=soye --profile=hyeobi
   transaction 463 / event 65 / retirement 227 · isa 85 · pension 86 · irp 65 /
   duplicate fingerprint 0 / negative holding 0 /
   postQuantity mismatch 0 (대조 가능 171) / finalHoldings 전 계좌 일치 /
   fingerprint_version [1] / orphan import_batch_id 0 /
   **id 별 source_fingerprint 변경 0건**

   멱등성 확인(2차 import) ✅
   batch  imp:verified_dataset_v1:2026-10-07T06:29:47.300Z
   inserted 0 / skipped 463, 전체 건수 463 그대로, batch 총 2행.
   기존 463행의 import_batch_id 는 **최초 batch 그대로** — 2차 batch 를
   가리키는 거래는 0건이고, 그것이 정상이다(재실행 이력일 뿐이다).

   ⚠ 이 단계에서 **정렬 버그**를 찾았다. compareIntraDayOrder 가 계좌 구분 없이
   sourceRow 를 비교해 전순서가 아니었고, 그래서 입력 순서에 따라 결과가
   달라졌다(DB 순서로 mismatch 12건). `f8ad88b` 에서 고쳤고
   `ledger-order.test.ts` 가 순서 독립성을 고정한다. 상세는 §5 참고.

I. 신규 거래 이력 UI 검증
   I-1. 읽기 검증  ✅ 완료 (2026-10-07, 아이폰 Safari 실기기)
        목록 / 계좌·기간·매수매도 필터 / 검색 / 상세 / 날짜 추정 배지 /
        null 은 0 이 아니라 "—" / 모바일 카드 레이아웃 — 전부 기대값과 일치.
        특히 2026-06-26 ISA 상세에서 같은 종목 연속 거래의
        991 → 1029 → 1302 → 803 순서가 증권사 거래후잔고와 모두 일치함을 확인했다.

   I-2. write smoke test (B~F)  ⏸ **보류 — 아직 하지 않았다**
        memo / tag / correction / split·move 를 실제 UI 에서 돌려보고 DB 로
        확인하는 단계. 숨김·복원(D)만 §2 의 경위로 우연히 검증됐다.
        **자동화는 막혀 있다** — production SESSION_SECRET 이 `.dev.vars` 값과
        달라(Cloudflare 시크릿은 읽기 불가) 테스트 토큰을 만들 수 없고,
        로컬 dev 서버는 `env` 가 undefined 라 /api 를 서빙하지 못한다(§8-3).
        production 시크릿 변경·공유·별도 테스트 Worker 는 모두 하지 않기로 했다.
        → 재개하려면 **사용자가 UI 에서 한 단계씩 조작하고 그때마다 DB 로 확인**하는
          방식으로 간다. 대상 후보는 정해져 있다:
            B·C·D: `rev:isa:2026-06-11` (체결 1건 — TIGER 미국S&P500 18주 매수)
            E     : 그 이벤트의 유일한 거래 `vtx:8245b2c1abf10fdf`
            F     : `rev:pension:2026-06-26` (체결 3건 — 1건만 떼어내고 복귀)

J. legacy consumer 전환  ⏸ **보류 — 아직 시작하지 않았다**
   snapshot.ts / kaw_portfolio_live_view / historical-performance.ts /
   benchmark-series.ts / backtest.ts 의 보유수량 소스를 원장으로 옮기는 계획.
   **각 소비처마다 전환 전후 수치를 대조한 뒤 하나씩** 옮긴다.
   원장 재생 최종 보유수량 vs 현재 계좌 보유수량 대조가 그 전환의 게이트다.
```

> **다음 우선 작업은 I-2 도 J 도 아니다.** "대시보드 기간 성과 → 수익 분석 개편"
> 으로 넘어간다. 거래 원장은 production 데이터와 배포가 모두 정상인 상태로
> 멈춰 있으므로 그대로 두면 되고, 나중에 위 두 항목만 이어서 하면 된다.



---

## 10. 명령어 요약

```bash
cd k-allweather/app

npm run dev                 # http://localhost:8080 (API 는 dev 에서 동작하지 않는다)
npm test                    # vitest — 676건
npx tsc --noEmit
npm run build

npm run ledger:dry-run      # 검증만. DB 에 쓰지 않는다 (기본)
npm run ledger:dry-run -- --family=soye --profile=hyeobi    # DB 읽기 포함
npm run ledger:verify -- --family=soye --profile=hyeobi     # 적재 후 검증(읽기 전용) 24항목
npm run ledger:import -- --apply --family=soye --profile=hyeobi   # 승인 후에만

npx vitest run src/lib/kaw/ledger-migration.test.ts   # 004 권한 모델 고정 테스트
npx vitest run src/lib/kaw/ledger-order.test.ts       # 정렬 순서 독립성 고정 테스트

# 배포 (프로젝트 기존 경로 — package.json 에 deploy 스크립트는 없다)
npm run build && npx wrangler deploy
```

게이트 현황: `tsc` 통과 / `build` 통과 / `test` **676건 통과 (18 파일)**.

production 배포: `https://portfolio.hyeobi.workers.dev` — 최신 버전 `ddae2703` (`f6c2a66`).
